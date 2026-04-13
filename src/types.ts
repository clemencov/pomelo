export interface Task {
  id: string
  name: string
  intervalDays: number
  lastDone: string | null // ISO date string
  snoozedUntil: string | null // ISO date string
}

export interface LogEntry {
  id: string
  taskId: string
  taskName: string
  doneAt: string // ISO date string
}
