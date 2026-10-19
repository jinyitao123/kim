export type EmployeeBusinessValue = string | number | boolean
export interface EmployeeBusinessRecord { objectName: string; recordId: string; label: string }
export interface EmployeeBusinessSource { kind: 'record' | 'business_notification' | 'approval'; reference?: string }
export interface EmployeeBusinessSelection { record: EmployeeBusinessRecord; source: EmployeeBusinessSource }
export type EmployeeBusinessReferenceName = 'customer_id' | 'contact_id' | 'opportunity_id' | 'quotation_type_id' | 'issuer_id' | 'sku_id'
export interface EmployeeBusinessCreationSelection { /** Host-only verified names; never sent to Forge. */ referenceFacts?: Partial<Record<EmployeeBusinessReferenceName, Record<string, { name: string; code?: string; uniqueQuery?: string }>>>; skuNames?: Record<string, { name: string; materialName: string; code?: string }>; referenceIds?: Partial<Record<EmployeeBusinessReferenceName, string[]>>; objectName: 'forge_sales_lead' | 'forge_quotation'; source: { kind: 'creation' } }
export type EmployeeBusinessTarget = EmployeeBusinessSelection | EmployeeBusinessCreationSelection
export type EmployeeBusinessLineItem = Partial<Record<'line_type' | 'name' | 'sku_id' | 'quantity' | 'taxed_unit_price' | 'tax_rate' | 'discount_rate' | 'remarks', EmployeeBusinessValue>>
export interface EmployeeBusinessParameter {
  name: string; label: string; type: 'string' | 'number' | 'boolean' | 'date' | 'file'; required: boolean
  description?: string; enum?: EmployeeBusinessValue[]; minimum?: number; maximum?: number; maxLength?: number
  enumLabels?: Array<{ value: EmployeeBusinessValue; label: string }>
}
export interface EmployeeBusinessAction {
  action_ref: number; capabilityId: string; declarationVersion: string; label: string; description: string
  effect: 'read' | 'write'; executionMode: 'employee_only'; parameters: EmployeeBusinessParameter[]
  requiresRecord?: false
  lineItems?: { minItems: 1; maxItems: 100; fields: EmployeeBusinessParameter[] }
}
interface EmployeeBusinessContextBase {
  version: '1'; contextId: string; contextVersion: string; expiresAt: string; readOnly: true
  actions: EmployeeBusinessAction[]
}
export type EmployeeBusinessContext = EmployeeBusinessContextBase & (
  (EmployeeBusinessSelection & { recordVersion: string }) | (EmployeeBusinessCreationSelection & { objectLabel: string })
)
export interface EmployeeBusinessRequest {
  version: '1'; contextId: string; contextVersion: string; opKey: string
  employeeMessage: { sessionId: string; messageId: string; sha256: string }
  action_ref: number; values: Record<string, EmployeeBusinessValue>
  lineItems?: EmployeeBusinessLineItem[]
  file?: { parameter: string; fileId: string; name: string; mediaType: string; bytes: number; sha256: string }
}
export interface EmployeeBusinessOperation {
  version: '1'; operationId: string; contextId: string; requestDigest: string
  status: 'in_progress' | 'succeeded' | 'failed' | 'unknown'; repeated: boolean; updatedAt: string
  noEffect?: boolean; code?: string; summary?: string; recordReferences?: EmployeeBusinessRecord[]
}
export interface EmployeeBusinessWork {
  workKey: string; kind: 'quotation_follow_up' | 'contract_signature' | 'contract_order_conditions' | 'contract_prepayment' | 'prepayment_confirmation' | 'sales_order_creation' | 'sales_order_submission' | 'project_start'
  title: string; record: EmployeeBusinessRecord; recordVersion: string; updatedAt: string
  assignment: 'assigned' | 'needs_assignment'; assignmentReason?: 'no_eligible_employee' | 'multiple_eligible_employees'
}
