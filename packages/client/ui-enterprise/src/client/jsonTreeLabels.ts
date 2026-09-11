/**
 * JsonTree 的展示文案(企业包自带中文,不经 locale 命名空间);
 * 档案标签页与提交映射对话框共用同一份。
 */
import type { JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export const JSON_TREE_LABELS: JsonTreeLabels = {
  copyValue: '复制值',
  copyJson: '复制 JSON',
  copyPath: '复制路径',
  copyPrettyJson: '复制格式化 JSON',
  copyCompactJson: '复制紧凑 JSON',
  copied: '已复制',
  copyFailed: '复制失败',
  collapseNode: '折叠',
  expandNode: '展开',
  copyButtonTitle: action => action,
}
