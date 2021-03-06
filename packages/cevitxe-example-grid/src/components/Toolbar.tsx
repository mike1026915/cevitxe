﻿/** @jsx jsx */
import { jsx } from '@emotion/core'
import { collection } from 'cevitxe'
import { styles } from 'cevitxe-toolbar'
import { useSelector } from 'react-redux'
import { DataGenerator } from './DataGenerator'

export const Toolbar = () => (
  <div css={{ ...styles.toolbar, zIndex: 2 }}>
    <DataGenerator />
    <Loading />
    <Rows />
    {/* <Counter />
    <CounterProgress /> */}
  </div>
)

const Rows = () => {
  const rows = useSelector((state: any) => {
    return collection('rows').selectors.count(state)
  })
  return (
    <div css={styles.toolbarGroup}>
      <label>{rows} rows</label>
    </div>
  )
}
const Loading = () => {
  const loading = useSelector((state: any) => {
    return state === undefined
  })
  return loading ? (
    <div css={styles.toolbarGroup}>
      <label>Loading...</label>
    </div>
  ) : (
    <div />
  )
}
