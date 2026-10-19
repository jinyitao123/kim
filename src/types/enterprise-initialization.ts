/** Native action declarations, with credentials and operation keys owned by Host. */
export interface InitializationParameter {
  name: string
  label: string
  type: string
  required: boolean
  options?: Array<{ value: string | number | boolean; label: string }>
}
export interface InitializationAction {
  name: string
  objectName: string
  label: string
  description: string
  effect: 'read' | 'write'
  requiresRecord: boolean
  requiresConfirmation: boolean
  params: InitializationParameter[]
}
export interface NativeInitializationActionArguments {
  actionName: string
  objectName: string
  recordId?: string
  params: Record<string, unknown>
}
