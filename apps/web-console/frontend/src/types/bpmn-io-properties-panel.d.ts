/**
 * BPMN properties panel 相关包的类型声明(两包均未自带 .d.ts)。
 *
 * <p>@bpmn-io/properties-panel v3 的导出(TextFieldEntry/SelectEntry 等)是组件本体,
 * 须在渲染上下文调用并返回 JSX;entry 对象形态为 { id, component, isEdited }。
 * getValue 被组件以 element 调用;setValue 签名为 (value, validationError?),
 * 无 element 首参(与内置 provider 的 value => {} 一致)。
 * bpmn-js-properties-panel 导出 bpmn-js additionalModules 用的 DI 模块。
 */

declare module '@bpmn-io/properties-panel' {
  export interface Entry {
    id: string
    [key: string]: unknown
  }

  /**
   * debounce 工厂:DI 服务 debounceInput 的返回值;文本类 entry 的输入回调经它包装,
   * 缺失时组件抛 "debounceFn is not a function"。
   */
  export type DebounceFactory = (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown

  export interface BaseEntryProps {
    id: string
    element: unknown
    label: string
    description?: string
    disabled?: boolean
    placeholder?: string
    tooltip?: unknown
    debounce?: DebounceFactory
  }

  export interface TextFieldEntryProps extends BaseEntryProps {
    getValue: (element: unknown) => string
    setValue: (value: string, validationError?: string | null) => void
    validate?: (value: string) => string | null
    monospace?: boolean
  }

  export interface TextAreaEntryProps extends TextFieldEntryProps {
    rows?: number
    autoResize?: boolean
  }

  export interface JsonEditorEntryProps extends BaseEntryProps {
    getValue: (element: unknown) => string
    setValue: (value: string, validationError?: string | null) => void
    validate?: (value: string) => string | null
  }

  export interface SelectEntryProps extends BaseEntryProps {
    getValue: (element: unknown) => string
    setValue: (value: string, validationError?: string | null) => void
    getOptions: (element: unknown) => Array<{ value: string; label: string }>
    validate?: (value: string) => string | null
  }

  export interface CheckboxEntryProps extends BaseEntryProps {
    getValue: (element: unknown) => boolean
    setValue: (value: boolean) => void
  }

  export function TextFieldEntry(props: TextFieldEntryProps): Entry
  export function TextAreaEntry(props: TextAreaEntryProps): Entry
  export function JsonEditorEntry(props: JsonEditorEntryProps): Entry
  export function SelectEntry(props: SelectEntryProps): Entry
  export function CheckboxEntry(props: CheckboxEntryProps): Entry

  /** isEdited 谓词:判断 entry 渲染结果相对默认值是否被编辑过(组头标记用)。 */
  export function isTextFieldEntryEdited(node: unknown): boolean
  export function isTextAreaEntryEdited(node: unknown): boolean
  export function isJsonEditorEntryEdited(node: unknown): boolean
  export function isSelectEntryEdited(node: unknown): boolean
  export function isCheckboxEntryEdited(node: unknown): boolean
}

declare module 'bpmn-js-properties-panel' {
  /** properties panel 渲染组件与服务的 DI 模块(additionalModules 用)。 */
  export const BpmnPropertiesPanelModule: Record<string, unknown>

  /** 内置 BPMN 通用属性组(General 组:id/name 等)的 DI 模块。 */
  export const BpmnPropertiesProviderModule: Record<string, unknown>
}
