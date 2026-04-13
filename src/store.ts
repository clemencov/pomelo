import type { Task } from './types'

const TASKS_KEY = 'pomelo:tasks'

export function loadTasks(): Task[] {
  try {
    return JSON.parse(localStorage.getItem(TASKS_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveTasks(tasks: Task[]) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks))
}


export function daysUntilDue(task: Task): number {
  if (!task.lastDone) return 0
  const due = new Date(task.lastDone)
  due.setDate(due.getDate() + task.intervalDays)
  const diff = due.getTime() - Date.now()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

export function dueDateLabel(task: Task): string {
  if (!task.lastDone) return 'Never done'
  const days = daysUntilDue(task)
  if (days < 0) return `Overdue by ${Math.abs(days)}d`
  if (days === 0) return 'Due today'
  return `Due in ${days}d`
}
