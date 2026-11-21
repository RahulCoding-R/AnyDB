import { useEffect, useMemo, useState } from 'react'
import './styles.css'
import DatabaseDiagram from './components/DatabaseDiagram'

const API = 'https://arkansas-examining-share-workforce.trycloudflare.com'
const initialConnection = { host: 'localhost', port: '1521', service_name: 'FREEPDB1', username: 'HR', password: '', schema: 'HR' }

async function request(path, options = {}) {
  let apiKey = localStorage.getItem('anydb_api_key')

  if (!apiKey) {
    apiKey = window.prompt('Enter your AnyDB API key:')
    if (apiKey) {
      localStorage.setItem('anydb_api_key', apiKey)
    }
  }

  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey || '',
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`)
  return data
}

function App() {
  const [connection, setConnection] = useState(initialConnection)
  const [connected, setConnected] = useState(false)
  const [schema, setSchema] = useState(null)
  const [active, setActive] = useState('overview')
  const [selectedTable, setSelectedTable] = useState('')
  const [history, setHistory] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [selectedHistory, setSelectedHistory] = useState(null)
  const [sql, setSql] = useState('SELECT * FROM EMPLOYEES FETCH FIRST 20 ROWS ONLY')
  const [queryResult, setQueryResult] = useState(null)
  const [tableData, setTableData] = useState(null)
  const [dataPage, setDataPage] = useState(0)
  const [dataMode, setDataMode] = useState('view')
  const [draftRows, setDraftRows] = useState([])
  const [selectedRows, setSelectedRows] = useState([])
  const [pendingPreview, setPendingPreview] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [change, setChange] = useState({ object_name: '', change_type: 'DROP_COLUMN', column_name: '', constraint_name: '', new_data_type: 'VARCHAR2(100)' })

  const tables = schema?.tables || []
  const currentTable = tables.find((table) => table.name === selectedTable) || tables[0]
  const constraints = useMemo(() => (schema?.constraints || []).filter((item) => item.table_name === (currentTable?.name || selectedTable)), [schema, currentTable, selectedTable])

  useEffect(() => {
    request('/api/history').then((data) => setHistory(data.items || [])).catch(() => {})
  }, [])

  function updateConnection(key, value) {
    setConnection((old) => ({ ...old, [key]: value }))
  }

  async function connectOracle(event) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    try {
      const data = await request('/api/oracle/connect', { method: 'POST', body: JSON.stringify({ ...connection, port: Number(connection.port) }) })
      setSchema(data.schema); setConnected(true)
      setSelectedTable(data.schema.tables?.[0]?.name || '')
      setTableData(null); setDataPage(0); setDataMode('view'); setSelectedRows([])
      setChange((old) => ({ ...old, object_name: data.schema.tables?.[0]?.name || '' }))
      setNotice(`Connected to Oracle as ${data.username}.`)
      setActive('overview')
    } catch (err) { setConnected(false); setSchema(null); setError(err.message) }
    finally { setLoading(false) }
  }

  async function refreshSchema() {
    setLoading(true); setError(''); setNotice('')
    try {
      const data = await request('/api/oracle/refresh', { method: 'POST', body: '{}' })
      setSchema(data); setNotice('Schema refreshed from Oracle.')
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function runSql(event) {
    event.preventDefault(); setLoading(true); setError(''); setNotice(''); setQueryResult(null)
    const statement = (sql.trim().match(/^([a-z]+)/i)?.[1] || '').toUpperCase()
    const isDml = ['INSERT', 'UPDATE', 'DELETE'].includes(statement)
    if (isDml && !window.confirm(`${statement} changes data in your Oracle database. Execute and COMMIT this statement?`)) {
      setLoading(false); return
    }
    try {
      const data = await request('/api/oracle/query', { method: 'POST', body: JSON.stringify({ sql, confirm_changes: isDml }) })
      setQueryResult(data)
      if (isDml) {
        setNotice(data.message)
        const refreshed = await request('/api/oracle/refresh', { method: 'POST', body: '{}' })
        setSchema(refreshed)
        loadHistory()
      }
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function loadTableData(name = selectedTable, page = dataPage) {
    if (!name) return
    setLoading(true); setError(''); setNotice('')
    try {
      const data = await request(`/api/oracle/tables/${encodeURIComponent(name)}/rows?offset=${page * 50}&limit=50`)
      setTableData(data); setSelectedTable(name); setDataPage(page); setSelectedRows([]); setDraftRows(data.rows.map((row) => [...row])); setDataMode('view')
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  function primaryKeyForRow(row) {
    if (!tableData?.primary_key?.length) return null
    return Object.fromEntries(tableData.primary_key.map((column) => [column, row[tableData.columns.indexOf(column)]]))
  }

  function keyToken(row) { return JSON.stringify(primaryKeyForRow(row)) }

  function toggleSelectedRow(row) {
    const token = keyToken(row)
    setSelectedRows((old) => old.includes(token) ? old.filter((item) => item !== token) : [...old, token])
  }

  function startInsert() {
    setDataMode('insert')
    setDraftRows([...(tableData?.rows || []).map((row) => [...row]), (tableData?.columns || []).map(() => '')])
    setPendingPreview(false); setSelectedRows([])
  }

  function startUpdate() {
    setDataMode('update')
    setDraftRows((tableData?.rows || []).map((row) => [...row]))
    setPendingPreview(false); setSelectedRows([])
  }

  function editDraft(rowIndex, colIndex, value) {
    setDraftRows((old) => old.map((row, ri) => ri === rowIndex ? row.map((cell, ci) => ci === colIndex ? value : cell) : row))
  }

  async function commitVisualChanges() {
    if (!tableData) return
    setLoading(true); setError(''); setNotice('')
    try {
      if (dataMode === 'insert') {
        const row = draftRows[draftRows.length - 1]
        const values = Object.fromEntries(tableData.columns.map((col, i) => [col, row[i] === '' ? null : row[i]]))
        const data = await request(`/api/oracle/tables/${encodeURIComponent(selectedTable)}/rows`, { method: 'POST', body: JSON.stringify({ values }) })
        setNotice(data.message)
      } else if (dataMode === 'update') {
        const changes = []
        tableData.rows.forEach((original, i) => {
          const values = {}
          tableData.columns.forEach((col, j) => {
            if (!tableData.primary_key.includes(col) && String(original[j] ?? '') !== String(draftRows[i]?.[j] ?? '')) values[col] = draftRows[i][j] === '' ? null : draftRows[i][j]
          })
          if (Object.keys(values).length) changes.push({ key: primaryKeyForRow(original), values })
        })
        if (!changes.length) { setNotice('No changes to commit.'); setDataMode('view'); setPendingPreview(false); setLoading(false); return }
        const data = await request(`/api/oracle/tables/${encodeURIComponent(selectedTable)}/rows/batch-update`, { method: 'POST', body: JSON.stringify({ changes }) })
        setNotice(data.message)
      }
      setPendingPreview(false)
      await loadTableData(selectedTable, dataPage)
      await loadHistory()
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function deleteSelectedRows() {
    if (!tableData || !selectedRows.length) return
    setLoading(true); setError(''); setNotice('')
    try {
      const keys = tableData.rows.filter((row) => selectedRows.includes(keyToken(row))).map(primaryKeyForRow)
      const data = await request(`/api/oracle/tables/${encodeURIComponent(selectedTable)}/rows`, { method: 'DELETE', body: JSON.stringify({ keys }) })
      setNotice(data.message); setSelectedRows([])
      const refreshedSchema = await request('/api/oracle/refresh', { method: 'POST', body: '{}' })
      setSchema(refreshedSchema)
      await loadTableData(selectedTable, dataPage); await loadHistory()
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function analyze(event) {
    event.preventDefault(); setLoading(true); setError(''); setNotice(''); setAnalysis(null)
    try {
      const data = await request('/api/analyze', { method: 'POST', body: JSON.stringify({ ...change, column_name: change.column_name || null, constraint_name: change.constraint_name || null, new_data_type: change.new_data_type || null }) })
      setAnalysis(data); setNotice('Impact report saved to history.'); loadHistory()
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function loadHistory() {
    try { const data = await request('/api/history'); setHistory(data.items || []) } catch (err) { setError(err.message) }
  }

  async function deleteHistory(id) {
    try { await request(`/api/history/${id}`, { method: 'DELETE' }); setHistory((old) => old.filter((item) => item.id !== id)); if (selectedHistory?.id === id) setSelectedHistory(null) }
    catch (err) { setError(err.message) }
  }

  function chooseTable(name) {
    setSelectedTable(name)
    setChange((old) => ({ ...old, object_name: name, column_name: '', constraint_name: '' }))
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand brand-text" href="#overview" onClick={() => setActive('overview')}>AnyDB</a>
        <div className="connection-status"><span className={connected ? 'status-dot on' : 'status-dot'} />{connected ? `Connected · ${schema?.owner || connection.username}` : 'Not connected'}</div>
      </header>

      <main className="page">
        <section className="page-intro"><div><p className="eyebrow">DATABASE WORKSPACE</p><h1>Manage your Oracle db here</h1><p className="subtitle">Browse and manage table data visually, review schema-change risks, and keep a short history of analyses.</p></div></section>

        {error && <div className="message error"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
        {notice && <div className="message success"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}

        <section className="connection panel">
          <div className="section-heading"><div><p className="eyebrow">CONNECT TO Oracle DB</p><h2>Oracle connection</h2></div><span className="subtle"></span></div>
          <form onSubmit={connectOracle} className="connection-form">
            <label>Host<input value={connection.host} onChange={(e) => updateConnection('host', e.target.value)} required /></label>
            <label>Port<input type="number" min="1" max="65535" value={connection.port} onChange={(e) => updateConnection('port', e.target.value)} required /></label>
            <label>Service name<input value={connection.service_name} onChange={(e) => updateConnection('service_name', e.target.value)} required /></label>
            <label>Username<input value={connection.username} onChange={(e) => updateConnection('username', e.target.value)} required /></label>
            <label>Password<input type="password" value={connection.password} onChange={(e) => updateConnection('password', e.target.value)} required autoComplete="current-password" /></label>
            <label>Schema display name<input value={connection.schema} onChange={(e) => updateConnection('schema', e.target.value)} placeholder="Same as username" /></label>
            <div className="connect-actions"><button className="button primary" disabled={loading}>{loading ? 'Working…' : connected ? 'Reconnect' : 'Connect to Oracle DB'}</button>{connected && <button className="button secondary" type="button" onClick={refreshSchema} disabled={loading}>Refresh schema</button>}</div>
          </form>
        </section>

        <nav className="tabs" aria-label="Workspace sections">
          {[['overview', 'Schema details'], ['schema-map', 'Schema map'], ['dependencies', 'Dependencies'], ['data', 'SELECT / Data'], ['impact', 'Impact analysis'], ['history', `History${history.length ? ` (${history.length})` : ''}`]].map(([key, label]) => <button key={key} className={active === key ? 'tab active' : 'tab'} onClick={() => setActive(key)}>{label}</button>)}
        </nav>

        {!connected && <div className="empty-connect panel"><div className="empty-symbol">↳</div><h3>Connect to your Oracle database to begin</h3><p></p></div>}

        {connected && active === 'overview' && <section className="workspace-grid">
          <aside className="panel object-panel"><div className="section-heading"><div><p className="eyebrow">OBJECTS</p><h2>Tables <span className="count">{tables.length}</span></h2></div></div>
            <input className="search-input" placeholder="Filter tables…" onChange={(e) => { const value = e.target.value.toUpperCase(); document.querySelectorAll('[data-table-name]').forEach((el) => { el.hidden = !el.dataset.tableName.includes(value) }) }} />
            <div className="table-list">{tables.map((table) => <button hidden={false} data-table-name={table.name} key={table.name} onClick={() => chooseTable(table.name)} className={currentTable?.name === table.name ? 'table-item selected' : 'table-item'}><span className="table-glyph">▦</span><span>{table.name}</span><small>{table.columns.length}</small></button>)}</div>
            {!tables.length && <p className="subtle">No tables visible to this Oracle user.</p>}
          </aside>
          <section className="panel details-panel"><div className="section-heading"><div><p className="eyebrow">SCHEMA DETAILS</p><h2>{currentTable?.name || 'Select a table'}</h2></div><span className="count">{currentTable?.columns.length || 0} columns</span></div>
            {currentTable && <><div className="table-scroll"><table><thead><tr><th>Column</th><th>Data type</th><th>Nullable</th></tr></thead><tbody>{currentTable.columns.map((col) => <tr key={col.name}><td className="mono strong">{col.name}</td><td className="mono">{col.data_type}</td><td><span className={col.nullable === 'N' ? 'badge no' : 'badge'}>{col.nullable === 'N' ? 'NOT NULL' : 'YES'}</span></td></tr>)}</tbody></table></div>
            <div className="constraint-section"><div className="section-heading compact"><h3>Constraints</h3><span className="count">{constraints.length}</span></div>{constraints.length ? constraints.map((item) => <div className="constraint-item" key={item.name}><span className="constraint-type">{{ P: 'PK', R: 'FK', U: 'UNIQUE', C: 'CHECK' }[item.type] || item.type}</span><div><strong>{item.name}</strong><small>{item.columns.join(', ')}{item.references ? ` → ${item.references}` : ''}</small></div></div>) : <p className="subtle">No constraints found for this table.</p>}</div></>}
          </section>
        </section>}

        {connected && active === 'schema-map' && <section className="panel">
          <div className="section-heading"><div><p className="eyebrow">SCHEMA VISUALIZATION</p><h2>Database schema map</h2><p className="section-description">Tables, columns and foreign-key relationships discovered from Oracle metadata.</p></div></div>
          <DatabaseDiagram schema={schema} mode="schema" />
        </section>}

        {connected && active === 'dependencies' && <section className="panel">
          <div className="section-heading"><div><p className="eyebrow">OBJECT RELATIONSHIPS</p><h2>Dependency map</h2><p className="section-description">Views and database objects connected through Oracle dependency metadata.</p></div></div>
          <DatabaseDiagram schema={schema} mode="dependencies" />
        </section>}

        {connected && active === 'data' && <section className="panel data-panel">
          <div className="section-heading"><div><p className="eyebrow">02 / DATA MANAGEMENT</p><h2>Select a table and manage its rows</h2><p className="section-description">Browse tables and make data changes without writing SQL.</p></div><button className="button secondary" onClick={() => loadTableData(selectedTable, dataPage)} disabled={loading || !selectedTable}>Refresh rows</button></div>
          <div className="data-layout">
            <aside className="data-table-picker"><label className="field-label" htmlFor="data-table-select">Tables in connected schema</label><select id="data-table-select" value={selectedTable} onChange={(e) => { chooseTable(e.target.value); setDataPage(0); loadTableData(e.target.value, 0) }}><option value="">Choose a table</option>{tables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}</select><p className="subtle">{tables.length} tables available</p></aside>
            <div className="data-content">
              {!tableData && <div className="report-empty"><div className="empty-symbol">▦</div><h3>Select a table</h3><p>Choose a table from the list to view its records.</p></div>}
              {tableData && <>
                <div className="data-toolbar"><div><h3>{tableData.table}</h3><span className="subtle">{tableData.total} total rows · page {dataPage + 1}</span></div><div className="data-actions">
                  <button className={dataMode === 'insert' ? 'button primary' : 'button secondary'} onClick={startInsert} disabled={loading}>Insert</button>
                  <button className="button secondary" onClick={deleteSelectedRows} disabled={loading || !selectedRows.length || !tableData.primary_key.length}>Delete{selectedRows.length ? ` (${selectedRows.length})` : ''}</button>
                  <button className={dataMode === 'update' ? 'button primary' : 'button secondary'} onClick={startUpdate} disabled={loading || !tableData.primary_key.length}>Update</button>
                </div></div>
                {!tableData.primary_key.length && <p className="table-warning">This table has no primary key. Viewing and inserting are available; row updates and deletion are disabled to prevent changing the wrong records.</p>}
                <div className="table-scroll data-grid-scroll"><table className="data-grid"><thead><tr>{dataMode === 'view' && tableData.primary_key.length > 0 && <th className="check-col">Select</th>}{tableData.columns.map((col) => <th key={col}>{col}</th>)}</tr></thead><tbody>
                  {tableData.rows.map((row, ri) => <tr key={keyToken(row) || ri}>{dataMode === 'view' && tableData.primary_key.length > 0 && <td className="check-col"><input aria-label={`Select row ${ri + 1}`} type="checkbox" checked={selectedRows.includes(keyToken(row))} onChange={() => toggleSelectedRow(row)} /></td>}{row.map((value, ci) => <td key={tableData.columns[ci]}>{dataMode === 'update' ? (tableData.primary_key.includes(tableData.columns[ci]) ? <span className="locked-cell">{value ?? 'NULL'} <small>PK</small></span> : <input className="cell-input" aria-label={`${tableData.columns[ci]} row ${ri + 1}`} value={draftRows[ri]?.[ci] ?? ''} onChange={(e) => editDraft(ri, ci, e.target.value)} />) : value === null ? <span className="null-value">NULL</span> : String(value)}</td>)}</tr>)}
                  {dataMode === 'insert' && <tr className="insert-row">{draftRows[draftRows.length - 1]?.map((value, ci) => <td key={tableData.columns[ci]}><label className="sr-only">{tableData.columns[ci]}</label><input className="cell-input" aria-label={`New ${tableData.columns[ci]}`} placeholder={tableData.columns[ci]} value={value ?? ''} onChange={(e) => editDraft(draftRows.length - 1, ci, e.target.value)} /></td>)}</tr>}
                  {!tableData.rows.length && dataMode !== 'insert' && <tr><td colSpan={tableData.columns.length + 1} className="empty-cell">This table has no rows.</td></tr>}
                </tbody></table></div>
                {(dataMode === 'insert' || dataMode === 'update') && <div className="commit-bar"><span>{dataMode === 'insert' ? 'Fill in the new row. Leave optional fields blank to insert NULL.' : 'Edit cells directly. Primary-key cells are locked.'}</span><div><button className="button secondary" onClick={() => { setDataMode('view'); setPendingPreview(false); setDraftRows(tableData.rows.map((row) => [...row])) }}>Cancel</button><button className="button primary" onClick={() => setPendingPreview(true)} disabled={loading}>Review & commit</button></div></div>}
                {pendingPreview && <div className="commit-preview"><div><strong>Review changes</strong><p>{dataMode === 'insert' ? `Insert one new row into ${selectedTable}.` : `${tableData.rows.filter((row, i) => row.some((v, j) => String(v ?? '') !== String(draftRows[i]?.[j] ?? ''))).length} row(s) contain edits in ${selectedTable}.`}</p><small>Changes will be committed to Oracle as one transaction. If any update fails, all updates in this batch will roll back.</small></div><div><button className="button secondary" onClick={() => setPendingPreview(false)}>Go back</button><button className="button primary" onClick={commitVisualChanges} disabled={loading}>{loading ? 'Committing…' : 'Confirm commit'}</button></div></div>}
                <div className="pagination"><button className="button secondary" disabled={loading || dataPage === 0} onClick={() => loadTableData(selectedTable, dataPage - 1)}>Previous</button><span>Showing {tableData.total ? dataPage * 50 + 1 : 0}–{Math.min((dataPage + 1) * 50, tableData.total)} of {tableData.total}</span><button className="button secondary" disabled={loading || (dataPage + 1) * 50 >= tableData.total} onClick={() => loadTableData(selectedTable, dataPage + 1)}>Next</button></div>
              </>}
            </div>
          </div>
        </section>}

        {connected && active === 'impact' && <section className="impact-grid"><section className="panel"><div className="section-heading"><div><p className="eyebrow">03 / SAFETY</p><h2>Change impact analysis</h2></div></div><p className="section-description">Estimate dependencies before a proposed schema change. AnyDB analyzes metadata only; it will not execute the DDL.</p>
          <form className="impact-form" onSubmit={analyze}><label>Change type<select value={change.change_type} onChange={(e) => setChange((old) => ({ ...old, change_type: e.target.value }))}><option value="DROP_COLUMN">Drop a column</option><option value="MODIFY_DATATYPE">Modify a datatype</option><option value="DROP_CONSTRAINT">Drop a constraint</option></select></label>
            <label>Table<select value={change.object_name} onChange={(e) => setChange((old) => ({ ...old, object_name: e.target.value, column_name: '', constraint_name: '' }))} required>{tables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}</select></label>
            {change.change_type !== 'DROP_CONSTRAINT' && <label>Column<select value={change.column_name} onChange={(e) => setChange((old) => ({ ...old, column_name: e.target.value }))} required><option value="">Select column</option>{(tables.find((table) => table.name === change.object_name)?.columns || []).map((col) => <option key={col.name} value={col.name}>{col.name} · {col.data_type}</option>)}</select></label>}
            {change.change_type === 'DROP_CONSTRAINT' && <label>Constraint<select value={change.constraint_name} onChange={(e) => setChange((old) => ({ ...old, constraint_name: e.target.value }))} required><option value="">Select constraint</option>{(schema?.constraints || []).filter((item) => item.table_name === change.object_name).map((item) => <option key={item.name} value={item.name}>{item.name} · {({ P: 'Primary key', R: 'Foreign key', U: 'Unique', C: 'Check' })[item.type] || item.type}</option>)}</select></label>}
            {change.change_type === 'MODIFY_DATATYPE' && <label>Proposed datatype<input value={change.new_data_type} onChange={(e) => setChange((old) => ({ ...old, new_data_type: e.target.value }))} placeholder="e.g. VARCHAR2(100)" required /></label>}
            <button className="button primary" disabled={loading || !tables.length}>{loading ? 'Analyzing…' : 'Analyze impact'}</button>
          </form></section>
          <section className="panel report-panel">{analysis ? <><div className="section-heading"><div><p className="eyebrow">ANALYSIS REPORT</p><h2>{analysis.target.object}{analysis.target.column ? `.${analysis.target.column}` : ''}</h2></div><span className={`risk risk-${analysis.risk.toLowerCase()}`}>{analysis.risk} RISK</span></div><p className="section-description">{analysis.impact_count} potential impact{analysis.impact_count === 1 ? '' : 's'} found. Report #{analysis.history_id} saved.</p>
            {analysis.impacts.length ? analysis.impacts.map((item, i) => <div className="impact-item" key={`${item.object}-${i}`}><div><strong>{item.object}</strong><small>{item.object_type} · {item.severity}</small></div><p>{item.reason}</p><small className="evidence">Evidence: {item.evidence}</small></div>) : <div className="no-impacts"><strong>No direct impacts detected in visible metadata.</strong><p>This does not prove the change is safe. Check external code and dynamic SQL.</p></div>}
            <div className="impact-visual">
              <div className="section-heading compact"><div><p className="eyebrow">VISUAL IMPACT MAP</p><h3>Potentially affected objects</h3></div></div>
              <DatabaseDiagram
                schema={schema}
                mode="impact"
                highlightNames={[analysis.target.object, ...analysis.impacts.map((item) => item.object)]}
                impactItems={analysis.impacts}
                targetObject={analysis.target.object}
              />
            </div>
            <div className="report-notes"><h3>Recommended checks</h3><ul>{analysis.recommended_tests.map((item) => <li key={item}>{item}</li>)}</ul><h3>Limitations</h3><ul>{analysis.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div></> : <div className="report-empty"><div className="empty-symbol">◎</div><h3>Your report will appear here</h3><p>Choose a proposed change and analyze it to see potential dependencies and risk.</p></div>}</section></section>}

        {connected && active === 'history' && <section className="panel history-panel"><div className="section-heading"><div><p className="eyebrow">04 / RECORDS</p><h2>Analysis history</h2><p className="section-description">Impact reports and data-changing SQL activity metadata are stored locally. Records older than 7 days are automatically deleted.</p></div><button className="button secondary" onClick={loadHistory}>Refresh</button></div>
          {!history.length ? <div className="report-empty"><h3>No history yet</h3><p>Run an impact analysis to save your first report.</p></div> : <div className="history-list">{history.map((item) => <article className="history-item" key={item.id}><button className="history-main" onClick={() => setSelectedHistory(selectedHistory?.id === item.id ? null : item)}><span className="history-date">{new Date(item.created_at).toLocaleString()}</span><strong>{item.title}</strong><span className="history-target">{item.target}</span><span className={`risk risk-${item.risk.toLowerCase()}`}>{item.risk}</span><span className="history-count">{item.impact_count} impacts</span></button><button className="delete-button" title="Delete history item" onClick={() => deleteHistory(item.id)}>Delete</button>{selectedHistory?.id === item.id && <div className="history-detail"><pre>{JSON.stringify(item.details, null, 2)}</pre></div>}</article>)}</div>}
          <p className="retention-note">Automatic retention: 7 days · Maximum 200 recent records shown · Delete individual records any time.</p>
        </section>}

        <footer><span>AnyDB dbms project</span><span>124cs0009,124cs0002,124cs0026</span></footer>
      </main>
    </div>
  )
}

export default App
