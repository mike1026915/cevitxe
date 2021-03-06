import { DELETED } from './constants'
import A, { ChangeFn } from 'automerge'
import { DELETE_COLLECTION } from './constants'
import { ChangeMap, RepoSnapshot } from 'cevitxe-types'
import { Repo } from './Repo'

export interface CollectionOptions {
  idField?: string
}

/**
 * @param name The name of the collection.
 * @param idField The property of an object containing a unique identifier, normally a uuid.
 * Optional; defaults to 'id'.
 *
 * The collection function returns helpers for CRUD operations, hiding the implementation details of
 * multi-document state from the developer.
 *
 * Each of the reducers (`add`, `remove`, etc.) returns a dictionary of ProxyReducer functions or
 * flags for modifying the repo and/or one or many docs.
 *
 * Here's how this might be used in a reducer:
 * ```ts
 *  const { add, update, remove, drop } = collection('rows').reducers
 *  switch (type) {
 *    case actions.ITEM_ADD:
 *      return add(payload)
 *    case actions.ITEM_UPDATE:
 *      return update(payload)
 *    case actions.ITEM_REMOVE:
 *      return remove(payload)
 *    case actions.COLLECTION_CLEAR:
 *      return drop()
 * // ...
 * }
 * ```
 *
 * To access the items in a collection, use the selector methods.
 * ```ts
 *  const rowArray = collection('rows').selectors.getAll(state)
 *  const rowMap = collection('rows').selectors.getMap(state)
 * ```
 */
export function collection<T = any>(name: string, { idField = 'id' }: CollectionOptions = {}) {
  /**
   * ## How collections are stored
   *
   * Multiple collections can be stored side-by-side in a single `Repo`, with each item as an
   * individual root-level Automerge document. So a `Repo` might look something like this:
   * ```ts
   * {
   *   '__teachers__abcdef1234': {id: 'abcdef1234', first: 'Herb', last: 'Caudill' },
   *   '__teachers__qrs7890xyz': {id: 'qrs7890xyz', first: 'Diego', last: 'Mijelshon' },
   *   '__students__lmnopqrs12': {id: 'lmnopqrs12', first: 'Steve', last: 'Jobs' },
   *   '__students__qwerty1234': {id: 'qwerty1234', first: 'Steve', last: 'Wozniak' },
   * }
   * ```
   * There are no index documents, because it's currently impractical to store very large arrays as
   * Automerge documents. Instead, to know which docs belong to which collection, we create a key
   * that prepends the collection name to the document's unique ID.
   *
   * ### Deleting documents
   *
   * Since we don't have an index, we need to delete documents in two steps:
   *
   *    1. We mark them as deleted by adding a special DELETED flag. This allows the deletion to be
   *       persisted and propagated to peers.
   *       ```ts
   *       {
   *         '__teachers__abcdef1234': {id: 'abcdef1234', first: 'Herb', last: 'Caudill', [DELETED]: true },
   *         '__teachers__qrs7890xyz': {id: 'qrs7890xyz', first: 'Diego', last: 'Mijelshon' },
   *       }
   *       ```
   *    2. The repo then looks out for the DELETED flag and removes deleted items from the snapshot.
   *       (We don't ever delete the underlying change history, in case the document is undeleted.)
   *
   *
   * ### Dropping a collection
   *
   * We want to be able to drop a collection in a single action from a reducer, but we don't have an index
   * So instead of returning reducer functions, we return a new object keyed to the
   * collection name and containing just the DELETE_COLLECTION flag.
   * ```ts
   * {
   *   '__teachers__abcdef1234': {id: 'abcdef1234', first: 'Herb', last: 'Caudill', ['__DELETED']: true },
   *   '__teachers__qrs7890xyz': {id: 'qrs7890xyz', first: 'Diego', last: 'Mijelshon' },
   *   '__teachers': DELETE_COLLECTION
   * }
   */

  const keyName = collection.getKeyName(name)

  // these are for converting individual item IDs back and forth
  const idToKey = (id: string) => `${keyName}__${id}`
  const keyToId = (key: string) => key.replace(`${keyName}__`, '')

  const setDeleteFlag = (s: any) => Object.assign(s, { [DELETED]: true })

  // SELECTORS

  /**
   * Returns true if the given string is a key for this collection
   * @param maybeKey
   */
  const isCollectionKey = (maybeKey: string) => maybeKey.startsWith(`${keyName}__`)

  /**
   * Iterates over all keys for the collection when given the current redux state.
   * @param state The plain JSON representation of the state.
   */
  function* keys(state: RepoSnapshot<T> = {}) {
    for (const key in state) {
      const item = (state as any)[key]
      const shouldInclude = item && !item[DELETED]
      if (isCollectionKey(key) && shouldInclude) yield key
    }
  }

  function* ids(state: RepoSnapshot<T> = {}) {
    for (const key of keys(state)) {
      yield keyToId(key)
    }
  }

  /**
   * Given the redux state, returns an array containing all items in the collection.
   * @param state The plain JSON representation of the state.
   */
  const getAll = (state: RepoSnapshot<T> = {}) => {
    let result = []
    for (const key of keys(state)) result.push(state[key])
    return result
  }

  /**
   * Given the redux state, returns a map keying each item in the collection to its `id`.
   * @param state The plain JSON representation of the state.
   */
  const getMap = (state: RepoSnapshot<T> = {}): RepoSnapshot<T> => {
    let result = {} as any
    for (const key of keys(state)) result[keyToId(key)] = state[key]
    return result
  }

  /**
   * Returns the number of items in the collection when given the redux state.
   * @param state The plain JSON representation of the state.
   */
  const count = (state: RepoSnapshot<T> = {}) => {
    let i = 0
    for (const _ of keys(state)) i++
    return i
  }

  /**
   * Marks all items in the collection as deleted.
   * @param repo
   */
  const markAllDeleted = async (repo: Repo<any>) => {
    for (const documentId of repo.documentIds) {
      if (isCollectionKey(documentId)) {
        repo.change(documentId, setDeleteFlag)
      }
    }
  }

  /**
   * Removes all items in the collection from the snapshot.
   * @param repo
   */
  const removeAllFromSnapshot = (repo: Repo<any>) => {
    for (const documentId of repo.documentIds) {
      if (isCollectionKey(documentId)) {
        repo.removeSnapshot(documentId)
      }
    }
  }

  // REDUCERS

  const drop = () => {
    return { [keyName]: DELETE_COLLECTION }
  }

  const add = (item: A.Doc<T> | A.Doc<T>[]) => {
    const items: A.Doc<T>[] = Array.isArray(item) ? item : [item]
    const changeFunctions = {} as ChangeMap
    for (const item of items) {
      if (!item.hasOwnProperty(idField))
        throw new Error(`Item doesn't have a property called '${idField}'.`)
      const key = idToKey((item as any)[idField])
      changeFunctions[key] = (s: A.Doc<T>) => Object.assign(s, item)
    }
    return changeFunctions
  }

  /**
   * Takes an updated version of the given doc (can be partial); returns a function merging the
   * updates with the existing doc, mapped to the collection key corresponding to the id field in
   * item.
   * @param item An object containing the id of the item to modify, as well as the values to be
   * modified. This can be either a modified copy of the whole document, or just the fields to be
   * changed.
   */
  const update = (item: A.Doc<any>) => ({
    [idToKey(item[idField])]: (s: any) => Object.assign(s, item),
  })

  /**
   * Takes a change function and an id, and returns the function mapped to the collection key.
   */
  const change = (id: string, fn: ChangeFn<T>) => ({
    [idToKey(id)]: fn,
  })

  /**
   * Takes an id, and returns a delete flag mapped to the collection key.
   */
  const remove = ({ id }: { id: string }) => ({
    [idToKey(id)]: setDeleteFlag,
  })

  return {
    keyName,
    reducers: {
      drop,
      add,
      update,
      change,
      remove,
    },
    selectors: {
      keys,
      ids,
      getAll,
      getMap,
      count,
    },
    markAllDeleted,
    removeAllFromSnapshot,
  }
}

export namespace collection {
  /**
   * Given the collection's name, returns the `keyName` used internally for tracking the collection.
   *
   * @param {string} collectionName The collection name, e.g. `teachers`
   * @return The key name used internally for the collection (e.g. `__teachers`)
   */
  export const getKeyName = (collectionName: string): string => `__${collectionName}`

  /**
   * Given a collection's `keyName`, returns the collection's name.
   *
   * @param {string} keyName The key name used internally for the collection (e.g. `__teachers`)
   * @return The collection name, e.g. `teachers`
   */
  export const getCollectionName = (keyName: string): string => keyName.replace(/^__/, '')
}
