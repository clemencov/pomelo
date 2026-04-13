import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loadTasks, saveTasks, loadLog, saveLog, daysUntilDue } from './store'
import type { Task, LogEntry } from './types'
import { Check, Pencil, Plus, ScrollText, Clock, AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

function urgency(task: Task): 'overdue' | 'soon' | 'ok' | 'new' {
  if (!task.lastDone) return 'new'
  const days = daysUntilDue(task)
  if (days < 0) return 'overdue'
  if (days <= 7) return 'soon'
  return 'ok'
}

function dueLabel(task: Task): string {
  if (!task.lastDone) return 'Never done'
  const days = daysUntilDue(task)
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `In ${days}d`
}

function intervalLabel(days: number): string {
  if (days % 365 === 0) return `every ${days / 365}yr`
  if (days % 30 === 0) return `every ${days / 30}mo`
  if (days % 7 === 0) return `every ${days / 7}wk`
  return `every ${days}d`
}

function toDateInput(iso: string | null): string {
  if (!iso) return ''
  return iso.split('T')[0]
}

const urgencyConfig = {
  overdue: { bar: 'bg-red-500', label: 'text-red-600 dark:text-red-400', icon: AlertTriangle },
  soon:    { bar: 'bg-amber-400', label: 'text-amber-600 dark:text-amber-400', icon: Clock },
  ok:      { bar: 'bg-emerald-400', label: 'text-emerald-600 dark:text-emerald-400', icon: Check },
  new:     { bar: 'bg-slate-300', label: 'text-muted-foreground', icon: AlertTriangle },
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks)
  const [log, setLog] = useState<LogEntry[]>(loadLog)
  const [showAdd, setShowAdd] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [name, setName] = useState('')
  const [interval, setInterval] = useState('30')
  const [lastDone, setLastDone] = useState('')

  function openAdd() {
    setName(''); setInterval('30'); setLastDone('')
    setShowAdd(true)
  }

  function openEdit(task: Task) {
    setName(task.name)
    setInterval(String(task.intervalDays))
    setLastDone(toDateInput(task.lastDone))
    setEditingTask(task)
  }

  function addTask() {
    if (!name.trim()) return
    const updated = [...tasks, {
      id: crypto.randomUUID(),
      name: name.trim(),
      intervalDays: parseInt(interval) || 30,
      lastDone: lastDone ? new Date(lastDone).toISOString() : null,
    }]
    setTasks(updated); saveTasks(updated); setShowAdd(false)
  }

  function saveEdit() {
    if (!editingTask || !name.trim()) return
    const updated = tasks.map(t => t.id === editingTask.id
      ? { ...t, name: name.trim(), intervalDays: parseInt(interval) || 30, lastDone: lastDone ? new Date(lastDone).toISOString() : null }
      : t)
    setTasks(updated); saveTasks(updated); setEditingTask(null)
  }

  function deleteTask(id: string) {
    const updated = tasks.filter(t => t.id !== id)
    setTasks(updated); saveTasks(updated); setEditingTask(null)
  }

  function markDone(task: Task) {
    const now = new Date().toISOString()
    const updatedTasks = tasks.map(t => t.id === task.id ? { ...t, lastDone: now } : t)
    setTasks(updatedTasks); saveTasks(updatedTasks)
    const updatedLog = [{ id: crypto.randomUUID(), taskId: task.id, taskName: task.name, doneAt: now }, ...log]
    setLog(updatedLog); saveLog(updatedLog)
  }

  const sorted = [...tasks].sort((a, b) => daysUntilDue(a) - daysUntilDue(b))
  const today = new Date().toISOString().split('T')[0]
  const overdueCount = tasks.filter(t => urgency(t) === 'overdue' || urgency(t) === 'new').length

  const TaskForm = () => (
    <div className="space-y-4 py-2">
      <div className="space-y-1.5">
        <Label>Name</Label>
        <Input placeholder="e.g. Change water filter" value={name} onChange={e => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label>Repeat every (days)</Label>
        <Input type="number" min="1" value={interval} onChange={e => setInterval(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>Last done <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input type="date" value={lastDone} onChange={e => setLastDone(e.target.value)} max={today} />
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-xl mx-auto px-4 py-10">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-slate-400" />
              pomelo
            </h1>
            {overdueCount > 0 && (
              <p className="text-sm text-red-500 mt-0.5">{overdueCount} task{overdueCount > 1 ? 's' : ''} need attention</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowLog(true)}>
              <ScrollText className="w-4 h-4 mr-1.5" />
              Log
            </Button>
            <Button size="sm" onClick={openAdd}>
              <Plus className="w-4 h-4 mr-1" />
              Add task
            </Button>
          </div>
        </div>

        {/* Empty state */}
        {sorted.length === 0 && (
          <div className="text-center py-20 text-muted-foreground">
            <RefreshCw className="w-10 h-10 mx-auto mb-3 opacity-20" />
            <p className="font-medium">No recurring tasks</p>
            <p className="text-sm mt-1">Add something you do regularly</p>
          </div>
        )}

        {/* Task list */}
        <div className="space-y-2">
          {sorted.map(task => {
            const u = urgency(task)
            const cfg = urgencyConfig[u]
            const Icon = cfg.icon
            return (
              <Card key={task.id} className="overflow-hidden border-0 shadow-sm">
                <div className={cn('h-1 w-full', cfg.bar)} />
                <CardContent className="flex items-center gap-4 py-4 px-5">
                  <Icon className={cn('w-4 h-4 shrink-0', cfg.label)} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{task.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{intervalLabel(task.intervalDays)}</p>
                  </div>
                  <span className={cn('text-sm font-medium shrink-0', cfg.label)}>{dueLabel(task)}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-emerald-600"
                      onClick={() => markDone(task)}
                      title="Mark done"
                    >
                      <Check className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-muted-foreground"
                      onClick={() => openEdit(task)}
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* Add dialog */}
        <Dialog open={showAdd} onOpenChange={setShowAdd}>
          <DialogContent>
            <DialogHeader><DialogTitle>Add task</DialogTitle></DialogHeader>
            <TaskForm />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button onClick={addTask}>Add task</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit dialog */}
        <Dialog open={!!editingTask} onOpenChange={open => !open && setEditingTask(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit task</DialogTitle></DialogHeader>
            <TaskForm />
            <DialogFooter className="flex-row justify-between sm:justify-between">
              <Button variant="ghost" className="text-red-500 hover:text-red-600 hover:bg-red-50" onClick={() => editingTask && deleteTask(editingTask.id)}>
                Delete
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setEditingTask(null)}>Cancel</Button>
                <Button onClick={saveEdit}>Save</Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Log dialog */}
        <Dialog open={showLog} onOpenChange={setShowLog}>
          <DialogContent>
            <DialogHeader><DialogTitle>History</DialogTitle></DialogHeader>
            <div className="max-h-96 overflow-y-auto -mx-1 px-1">
              {log.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">No entries yet.</p>
              )}
              <div className="space-y-1 py-2">
                {log.map(entry => (
                  <div key={entry.id} className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-slate-50 dark:hover:bg-slate-900">
                    <div className="flex items-center gap-2">
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                      <span className="text-sm">{entry.taskName}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{new Date(entry.doneAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                ))}
              </div>
            </div>
          </DialogContent>
        </Dialog>

      </div>
    </div>
  )
}
