import { useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap, MarkerType } from 'reactflow'
import 'reactflow/dist/style.css'
import './diagram.css'

function nodeKey(type, name) {
  return `${type}:${name}`
}

function tableLabel(table, highlighted, compact) {
  return <div className={`diagram-node table-node${highlighted ? ' highlighted' : ''}`}>
    <strong>{table.name}</strong>
    {!compact && <div className="diagram-columns">{table.columns.slice(0, 8).map((column) => <span key={column.name}>{column.name} <em>{column.data_type}</em></span>)}{table.columns.length > 8 && <small>+{table.columns.length - 8} more columns</small>}</div>}
  </div>
}

function objectLabel(name, type, highlighted) {
  return <div className={`diagram-node object-node${highlighted ? ' highlighted' : ''}`}><strong>{name}</strong><small>{type}</small></div>
}

function buildGraph(schema, mode, highlightNames, compact, selectedId, impactItems = [], targetObject = '') {
  const highlighted = new Set(highlightNames.map((name) => name.toUpperCase()))
  const tables = schema?.tables || []
  const constraints = schema?.constraints || []
  const views = schema?.views || []
  const dependencies = schema?.dependencies || []
  const nodes = []
  const edges = []

  if (mode === 'schema' || mode === 'impact') {
    tables.forEach((table, index) => {
      const column = index % 3
      const row = Math.floor(index / 3)
      const id = nodeKey('TABLE', table.name)
      nodes.push({ id, searchName: table.name, position: { x: column * 310, y: row * 210 }, data: { label: tableLabel(table, highlighted.has(table.name) || selectedId === id, compact) }, className: highlighted.size && !highlighted.has(table.name) ? 'diagram-muted' : '' })
    })
    constraints.filter((constraint) => constraint.type === 'R' && constraint.references).forEach((constraint, index) => {
      const [targetTable, targetColumn] = constraint.references.split('.')
      const source = nodeKey('TABLE', constraint.table_name)
      const target = nodeKey('TABLE', targetTable)
      if (nodes.some((node) => node.id === source) && nodes.some((node) => node.id === target)) {
        edges.push({ id: `fk-${index}-${source}-${target}`, source, target, label: `${constraint.columns.join(', ')} → ${targetColumn || ''}`, markerEnd: { type: MarkerType.ArrowClosed }, className: highlighted.size && (!highlighted.has(constraint.table_name) && !highlighted.has(targetTable)) ? 'diagram-edge-muted' : '' })
      }
    })
    if (mode === 'impact') {
      impactItems.forEach((item, index) => {
        const id = nodeKey(item.object_type, item.object)
        if (!nodes.some((node) => node.id === id)) {
          nodes.push({ id, searchName: item.object, position: { x: 620, y: index * 120 }, data: { label: objectLabel(item.object, item.object_type, true) } })
        }
        const source = nodeKey('TABLE', targetObject)
        if (nodes.some((node) => node.id === source) && source !== id) {
          edges.push({ id: `impact-${index}-${source}-${id}`, source, target: id, label: item.severity, markerEnd: { type: MarkerType.ArrowClosed }, className: 'impact-edge' })
        }
      })
    }
  }

  if (mode === 'dependencies') {
    const objects = new Map()
    tables.forEach((table) => objects.set(nodeKey('TABLE', table.name), { name: table.name, type: 'TABLE' }))
    views.forEach((view) => objects.set(nodeKey('VIEW', view.name), { name: view.name, type: 'VIEW' }))
    dependencies.forEach((dependency) => {
      objects.set(nodeKey(dependency.type, dependency.name), { name: dependency.name, type: dependency.type })
      objects.set(nodeKey(dependency.referenced_type, dependency.referenced_name), { name: dependency.referenced_name, type: dependency.referenced_type })
    })
    Array.from(objects.values()).forEach((object, index) => {
      const column = index % 3
      const row = Math.floor(index / 3)
      const id = nodeKey(object.type, object.name)
      nodes.push({ id, searchName: object.name, position: { x: column * 300, y: row * 170 }, data: { label: objectLabel(object.name, object.type, highlighted.has(object.name) || selectedId === id) }, className: highlighted.size && !highlighted.has(object.name) ? 'diagram-muted' : '' })
    })
    dependencies.forEach((dependency, index) => {
      const source = nodeKey(dependency.type, dependency.name)
      const target = nodeKey(dependency.referenced_type, dependency.referenced_name)
      if (nodes.some((node) => node.id === source) && nodes.some((node) => node.id === target)) {
        edges.push({ id: `dependency-${index}-${source}-${target}`, source, target, markerEnd: { type: MarkerType.ArrowClosed }, className: highlighted.size && (!highlighted.has(dependency.name) && !highlighted.has(dependency.referenced_name)) ? 'diagram-edge-muted' : '' })
      }
    })
  }

  return { nodes, edges }
}

function DatabaseDiagram({ schema, mode = 'schema', highlightNames = [], compact = false, impactItems = [], targetObject = '' }) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const diagramRef = useRef(null)
  const graph = useMemo(() => buildGraph(schema, mode, highlightNames, compact, selectedId, impactItems, targetObject), [schema, mode, highlightNames, compact, selectedId, impactItems, targetObject])
  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === diagramRef.current)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])
  const focusIds = useMemo(() => {
    if (mode !== 'impact') return null
    const targetId = nodeKey('TABLE', targetObject)
    const ids = new Set([targetId])
    graph.nodes.filter((node) => highlightNames.some((name) => name.toUpperCase() === node.searchName.toUpperCase())).forEach((node) => ids.add(node.id))
    graph.edges.forEach((edge) => { if (edge.source === targetId || edge.target === targetId) { ids.add(edge.source); ids.add(edge.target) } })
    return ids
  }, [graph.edges, graph.nodes, highlightNames, mode, targetObject])
  const visibleNames = useMemo(() => new Set(graph.nodes.filter((node) => (!focusIds || focusIds.has(node.id)) && (!search || node.searchName.toLowerCase().includes(search.toLowerCase()))).map((node) => node.id)), [focusIds, graph.nodes, search])
  const nodes = graph.nodes.map((node) => {
    let className = node.className || ''
    if (mode === 'impact') {
      if (node.id === nodeKey('TABLE', targetObject)) className = 'impact-target'
      else if (highlightNames.some((name) => name.toUpperCase() === node.searchName.toUpperCase())) className = 'impact-affected'
      else if (focusIds?.has(node.id)) className = 'impact-related'
    }
    return { ...node, className, hidden: !visibleNames.has(node.id) }
  })
  const edges = graph.edges.map((edge) => ({ ...edge, hidden: !visibleNames.has(edge.source) || !visibleNames.has(edge.target) }))
  const toggleFullscreen = async () => {
    if (!diagramRef.current) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await diagramRef.current.requestFullscreen()
  }

  return <div className={`diagram-shell${fullscreen ? ' is-fullscreen' : ''}`} ref={diagramRef}>
    <div className="diagram-toolbar">
      <input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tables or objects..." />
      <div className="diagram-actions"><span className="subtle">{nodes.filter((node) => !node.hidden).length} objects · {edges.filter((edge) => !edge.hidden).length} relationships</span><button type="button" className="button secondary diagram-fullscreen" onClick={toggleFullscreen}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button></div>
    </div>
    <div className="diagram-canvas"><ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, node) => setSelectedId(node.id)} minZoom={0.25} maxZoom={1.8} attributionPosition="bottom-left"><MiniMap pannable zoomable /><Controls /><Background gap={24} size={1} /></ReactFlow></div>
    {mode === 'impact' && <div className="diagram-legend"><span><i className="legend-dot changed" /> Proposed change</span><span><i className="legend-dot affected" /> Affected object</span><span><i className="legend-dot related" /> Related table</span></div>}
    <p className="diagram-note">metadata visualised</p>
  </div>
}

export default DatabaseDiagram
