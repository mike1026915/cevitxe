﻿import A from 'automerge'
import { newid } from 'cevitxe-signal-client'
import debug from 'debug'
import Cache from 'lru-cache'
import * as R from 'ramda'
import { DELETED } from './constants'
import { IdbAdapter } from 'cevitxe-storage-indexeddb'
import { StorageAdapter } from 'cevitxe-storage-abstract'
import { ChangeSet, RepoHistory, RepoSnapshot, ClockMap, Clock } from 'cevitxe-types'
import { mergeClocks, EMPTY_CLOCK, getClock } from './clocks'

export type RepoEventHandler<T> = (documentId: string, doc: A.Doc<T>) => void | Promise<void>

interface RepoOptions {
  /** The discovery key is a unique ID for this dataset, used to identify it when seeking peers with
   *  whom to synchronize. In the example apps we use randomly generated two-word names like
   *  `golden-lizard`. It could also be a UUID. */
  discoveryKey: string

  /** Name to distinguish this application's data from others that this browser might have stored; * e.g. `grid` or `todos`. */
  databaseName: string

  /** Unique identifier representing this peer */
  clientId?: string

  /** Storage adapter to use. Defaults to `IdbAdapter` */
  storage?: StorageAdapter
}

/**
 * A Repo manages a set of Automerge documents. For each document, it persists:
 *   1. the document history (in an append-only log of changes), and
 *   2. a snapshot of the document's latest state.
 *
 * Each repo is uniquely identified by a discovery key.
 *
 * A repo is instantiated by StoreManager when creating or joining a store. Actions coming from the
 * store are passed onto the repo, as are changes received from peers.
 *
 * ### Storage schema
 *
 * We use a single database with two object stores: `changes`, containing changesets in sequential
 * order, indexed by documentId; and `snapshots`, containing the document's current state as a plain
 * JavaScript object.
 *
 * There is one repo (and one database) per discovery key.
 *
 * ```
 * cevitxe_grid_fancy-lizard (DB)
 *   changes (object store)
 *     1: { id:1, documentId: abc123, changeSet: [...]}
 *     2: { id:2, documentId: abc123, changeSet: [...]}
 *     3: { id:3, documentId: abc123, changeSet: [...]}
 *     4: { id:4, documentId: qrs567, changeSet: [...]}
 *     5: { id:5, documentId: qrs567, changeSet: [...]}
 *     6: { id:6, documentId: qrs567, changeSet: [...]}
 *   snapshots (object store)
 *     abc123: { documentId: abc123, snapshot: {...}, clock: {...}}
 *     qrs567: { documentId: qrs567, snapshot: {...}, clock: {...}}
 * ```
 */
export class Repo<T = any> {
  private log: debug.Debugger
  private storage: StorageAdapter

  public databaseName: string
  public clientId: string

  /** In-memory map of document snapshots */
  private state: RepoSnapshot = {}

  /** In-memory map of document clocks */
  public clock: ClockMap = {}

  /** LRU cache of recently accessed Docs */
  private docCache: Cache<string, any>

  /** Document change event listeners. Each handler fires every time a document is set or removed. */
  private handlers: Set<RepoEventHandler<T>>

  constructor(options: RepoOptions) {
    const { discoveryKey, databaseName, clientId = newid(), storage } = options
    this.log = debug(`cevitxe:repo:${databaseName}`)

    this.databaseName = databaseName
    this.handlers = new Set()
    this.docCache = new Cache({ max: 1000 })
    this.clientId = clientId

    // Use IdbAdapter by default
    this.storage = storage || new IdbAdapter({ databaseName, discoveryKey })
  }

  // PUBLIC METHODS

  open = async () => await this.storage.open()
  close = () => this.storage.close()

  /**
   * Initializes the repo and returns a snapshot of its current state.
   * @param initialState The starting state to use when creating a new repo.
   * @param creating Use `true` if creating a new repo, `false` if joining an existing repo (one
   * that we already created locally, or that a peer has)
   * @returns A snapshot of the repo's current state.
   */
  async init(initialState: any, creating: boolean): Promise<RepoSnapshot> {
    await this.open()
    const hasData = await this.hasData()
    this.log('hasData', hasData)
    if (creating) {
      this.log('creating a new repo')
      await this.createFromSnapshot(initialState)
    } else if (!hasData) {
      this.log(`joining a peer's document for the first time`)
      await this.createFromSnapshot({})
    } else {
      this.log('recovering an existing repo from persisted state')
      await this.loadSnapshotsFromDb()
    }
    return this.state
  }

  /**
   * Creates a new repo with the given initial state.
   * @param initialState
   */
  async createFromSnapshot(state: RepoSnapshot<T>) {
    for (let documentId in state) {
      const snapshot = state[documentId]
      if (snapshot !== null) {
        const document = A.from(snapshot)
        await this.set(documentId, document)
      }
    }
  }

  /** Returns all of the repo's document IDs from memory. */
  get documentIds() {
    return Object.keys(this.state)
  }

  /** @returns true if this repo has this document (even if it's been deleted) */
  has(documentId: string): boolean {
    // if the document has been deleted, its snapshot set to `null`, but the map still contains the entry
    return this.state.hasOwnProperty(documentId)
  }

  /** Returns the number of document IDs that this repo has (including deleted) */
  get count() {
    return this.documentIds.length
  }

  /** Reconstitutes an Automerge document from its change history  */
  async get(documentId: string): Promise<A.Doc<T> | undefined> {
    // TODO: reimplement caching
    this.log('get', documentId)
    return await this.rebuildDoc(documentId)
  }

  /**
   * Saves the document's change history and snapshot, and updates our in-memory state.
   * @param documentId The ID of the document
   * @param doc The new version of the document
   * @param changes (optional) If we're already given the changes (e.g. in `applyChanges`), we can
   * pass them in so we don't have to recalculate them.
   */
  async set(documentId: string, doc: A.Doc<T>, changes?: A.Change[]) {
    this.log('set', documentId, doc)

    // look up old doc and generate diff
    if (!changes) {
      const oldDoc = (await this.rebuildDoc(documentId)) || A.init()
      try {
        changes = A.getChanges(oldDoc, doc)
      } catch (error) {
        this.log({ error, oldDoc, doc })
        changes = []
      }
    }
    // cache the doc
    this.docCache.set(documentId, doc)

    // only if Automerge actually found changes in the new document...
    if (changes.length > 0) {
      // append changes to this document's history
      await this.appendChangeSet({ documentId, changes })

      // save snapshot
      await this.saveSnapshot(documentId, doc)

      // call handlers
      for (const fn of this.handlers) await fn(documentId, doc)
    }
  }

  /**
   * Updates a document using an Automerge change function (e.g. from a reducer)
   * @param documentId The ID of the document
   * @param changeFn An Automerge change function
   * @returns The updated document
   */
  async change(documentId: string, changeFn: A.ChangeFn<T>) {
    this.log('change', documentId)
    // apply changes to document
    const oldDoc = (await this.rebuildDoc(documentId)) || A.init()
    const newDoc = A.change(oldDoc, changeFn)

    // save the new document, snapshot, etc.
    await this.set(documentId, newDoc)

    // return the modified document
    return newDoc
  }

  /**
   * Updates a document using a set of Automerge changes (typically received from a peer).
   * @param documentId The ID of the document
   * @param changes A diff in the form of an array of Automerge change objects
   * @returns The updated document
   */
  async applyChanges(documentId: string, changes: A.Change[]) {
    // apply changes to document
    const doc = (await this.rebuildDoc(documentId)) || A.init()
    const newDoc = A.applyChanges(doc, changes)

    await this.set(documentId, newDoc, changes)

    // return the modified document
    return newDoc
  }

  /**
   * Used for sending the entire current state of the repo to a new peer.
   * @returns  an object mapping documentIds to an array of changes.
   */
  async *getHistory(batchSize: number = 1000): AsyncGenerator<RepoHistory> {
    let history: RepoHistory = {}
    let i = 0
    for await (const { documentId, changes } of this.storage.changes()) {
      history[documentId] = (history[documentId] || []).concat(changes)
      if (i++ > batchSize) {
        yield history
        i = 0
        history = {}
      }
    }
    yield history
  }

  /** Used when receiving the entire current state of a repo from a peer. */
  async loadHistory(history: RepoHistory) {
    for (const documentId in history) {
      const changes = history[documentId]
      await this.applyChanges(documentId, changes)
    }
  }

  /**
   * Accessor for a document's clock
   * @param documentId
   * @returns Our clock, or if none exists, an empty clock
   */
  public getClock(documentId: string) {
    return this.clock[documentId] || EMPTY_CLOCK
  }

  /** Returns true if we have a clock in memory for this document */
  public hasClock(documentId: string) {
    return this.clock.hasOwnProperty(documentId)
  }

  /** Returns our entire ClockMap as-is */
  public getClocks() {
    return this.clock
  }

  /**
   * Updates the vector clock by merging in the new vector clock `clock`, setting each node's
   * sequence number to the maximum for that node
   * @param documentId
   * @param newClock
   */
  public updateClock(documentId: string, newClock: Clock) {
    const oldClock = this.clock[documentId]
    this.clock[documentId] = mergeClocks(oldClock, newClock)
  }

  /**
   * Gets the in-memory snapshot of a document
   * @param documentId
   * @returns  a plain JS object
   */
  getSnapshot(documentId: string) {
    return this.state[documentId]
  }

  /**
   * Changes the snapshot of a document synchronously, without modifying the underlying Automerge
   * changes. This is used to quickly update the UI; the change history can be updated later.
   * @param documentId
   * @param fn The change function (usually comes from a ProxyReducer)
   */
  changeSnapshot(documentId: string, fn: A.ChangeFn<T>) {
    // create a new throw-away automerge object from the current version's snapshot
    const oldDoc = this.getSnapshot(documentId) || {}

    const doc: A.Doc<any> = A.from(clone(oldDoc))

    // apply the change
    const newDoc = A.change(doc, fn)

    // convert the result back to a plain object
    const snapshot = clone(newDoc)

    this.setSnapshot(documentId, snapshot)
    this.log('changed snapshot', documentId, snapshot)
  }

  /**
   * Sets the in-memory snapshot of a document.
   * > NOTE: This does not update the document's change history or persist anything; it's just to
   * allow synchronous updates of the state for UI purposes.
   * @param documentId
   * @param snapshot
   */
  setSnapshot(documentId: string, snapshot: any) {
    if (snapshot.DELETED) {
      this.removeSnapshot(documentId)
    } else {
      this.state[documentId] = snapshot
    }
  }

  /**
   * Removes the snapshot with the given `documentId` from in-memory state. (More precisely, sets it
   * to `null` as a marker that we've seen the document before.)
   * @param documentId
   */
  removeSnapshot(documentId: string) {
    this.log('removeSnapshot', documentId)
    this.state[documentId] = null
  }

  /** Returns the state of the entire repo, containing snapshots of all the documents. */
  getState(): RepoSnapshot<T> {
    return this.state
  }

  /**
   * Replaces the (snapshot) state of the entire repo.
   * > NOTE: This doesn't update the repo's change history or persist anything; this is only used
   * for synchronous updates of the state for UI purposes.
   */
  loadState(state: RepoSnapshot<T>) {
    this.state = Object.assign(this.state, state)
  }

  /** Adds a change event listener */
  addHandler(handler: RepoEventHandler<T>) {
    this.handlers.add(handler)
  }

  /** Removes a change event listener */
  removeHandler(handler: RepoEventHandler<T>) {
    this.handlers.delete(handler)
  }

  // PRIVATE METHODS

  /** @returns `true` if there is any stored data in the repo. */
  private async hasData() {
    return this.storage.hasData()
  }

  /** Loads all the repo's snapshots into memory */
  private async loadSnapshotsFromDb() {
    // TODO: only problem with this approach is that we're not storing clocks for deleted documents
    for await (const { documentId, snapshot, clock } of this.storage.snapshots()) {
      this.state[documentId] = snapshot[DELETED] ? null : snapshot
      this.clock[documentId] = clock
    }
  }

  /** Recreates an Automerge document from its change history */
  private async rebuildDoc(documentId: string): Promise<A.Doc<T> | undefined> {
    if (!this.has(documentId)) return undefined
    let doc = A.init<T>({ actorId: this.clientId })
    const changeSets = await this.getDocumentChanges(documentId)
    for (const { changes } of changeSets) //
      if (changes) doc = A.applyChanges(doc, changes)
    return doc
  }

  /** Adds a set of changes to the document's append-only history. */
  private async appendChangeSet(changeSet: ChangeSet) {
    this.log('appending changeset', changeSet.documentId, changeSet.changes.length)
    this.storage.appendChanges(changeSet)
  }

  /**
   * Gets all stored changesets from a document's history.
   * @param documentId The ID of the requested document.
   * @returns An array of changesets in order of application.
   */
  private async getDocumentChanges(documentId: string): Promise<ChangeSet[]> {
    this.log('getChangeSets', documentId)
    return this.storage.getChanges(documentId)
  }

  /** Saves the snapshot for the given `documentId`, replacing any existing snapshot. */
  private async saveSnapshot(documentId: string, document: A.Doc<T>) {
    const snapshot: any = clone(document)
    const clock = getClock(document)
    this.updateClock(documentId, clock)

    if (snapshot[DELETED]) {
      this.removeSnapshot(documentId)
      await this.storage.deleteSnapshot(documentId)
    } else {
      this.log('saveSnapshot', documentId, document)
      this.setSnapshot(documentId, snapshot)
      await this.storage.putSnapshot({ documentId, snapshot, clock })
    }
  }
}

// deep clone without Automerge metadata
const clone = (o: any) => R.clone(o)
