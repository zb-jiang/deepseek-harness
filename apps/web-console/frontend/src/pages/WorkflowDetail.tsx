import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  EditOutlined,
  PlayCircleOutlined,
  SaveOutlined,
} from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  type BpmnValidationResult,
  type UpdateWorkflowMetaRequest,
  type WorkflowDefinitionDto,
  workflowsApi,
} from '../api/workflows'
import { rolesApi } from '../api/roles'
import { appsApi, type ApplicationDto } from '../api/apps'
import { backendProfilesApi } from '../api/backend-profiles'
import { type OrgUnitTreeNode, orgUnitsApi } from '../api/org-units'
import BpmnModeler from '../bpmn/BpmnModeler'
import {
  setDshRoleOptions,
  setDshSkillOptions,
  setDshBackendProfileOptions,
  setDshOrgUnitOptions,
} from '../bpmn/DshPropertiesProvider'

const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  published: 'green',
  disabled: 'orange',
  archived: 'red',
}

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  disabled: '已停用',
  archived: '已归档',
}

/**
 * 部门树 → 扁平选项清单(value=部门 id,label=到根路径,如「总公司 / 华东区」),
 * 供属性面板"指定部门"下拉渲染。
 */
function flattenOrgUnitTree(
  nodes: OrgUnitTreeNode[],
  parentPath: string[] = [],
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const n of nodes) {
    const path = [...parentPath, n.name]
    out.push({ value: n.id, label: path.join(' / ') })
    out.push(...flattenOrgUnitTree(n.children ?? [], path))
  }
  return out
}

/**
 * 默认 BPMN 模板:起止 + 单个审批 userTask。
 *
 * <p>命名空间对齐引擎侧 DshBpmnExtensionParser(http://dsh.ai/bpmn);
 * dsh 元数据不在模板中手写——画布上选中节点后在右侧 properties panel
 * 的"DSH 人工节点配置"组配置。必须带 BPMNDI 图形信息,否则画布无法渲染。
 */
const DEFAULT_BPMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
            xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
            xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
            xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
            xmlns:flowable="http://flowable.org/bpmn"
            xmlns:dsh="http://dsh.ai/bpmn"
            targetNamespace="http://dsh.ai/bpmn">
  <process id="dsh_process_1" name="示例流程" isExecutable="true">
    <startEvent id="start_1" name="开始"/>
    <userTask id="task_1" name="审批"/>
    <endEvent id="end_1" name="结束"/>
    <sequenceFlow id="flow_1" sourceRef="start_1" targetRef="task_1"/>
    <sequenceFlow id="flow_2" sourceRef="task_1" targetRef="end_1"/>
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="dsh_process_1">
      <bpmndi:BPMNShape id="start_1_di" bpmnElement="start_1">
        <dc:Bounds x="152" y="102" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="task_1_di" bpmnElement="task_1">
        <dc:Bounds x="240" y="80" width="100" height="80"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="end_1_di" bpmnElement="end_1">
        <dc:Bounds x="392" y="102" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="flow_1_di" bpmnElement="flow_1">
        <di:waypoint x="188" y="120"/>
        <di:waypoint x="240" y="120"/>
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="flow_2_di" bpmnElement="flow_2">
        <di:waypoint x="340" y="120"/>
        <di:waypoint x="392" y="120"/>
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`

export default function WorkflowDetailPage() {
  const { workflowId = '' } = useParams()
  const { message } = App.useApp()
  const navigate = useNavigate()

  const [wf, setWf] = useState<WorkflowDefinitionDto | null>(null)
  const [app, setApp] = useState<ApplicationDto | null>(null)
  const [editMetaOpen, setEditMetaOpen] = useState(false)
  const [metaForm] = Form.useForm<UpdateWorkflowMetaRequest>()

  const [bpmnXml, setBpmnXml] = useState('')
  const [xmlDirty, setXmlDirty] = useState(false)
  const [validation, setValidation] = useState<BpmnValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!workflowId) return
    try {
      const data = await workflowsApi.get(workflowId)
      setWf(data)
      setBpmnXml(data.draftBpmnXml ?? DEFAULT_BPMN_XML)
      setXmlDirty(false)
      setValidation(null)
      // 加载所属应用信息,用于显示应用名
      let appData: ApplicationDto | null = null
      try {
        appData = await appsApi.get(data.appId)
        setApp(appData)
      } catch {
        setApp(null)
      }
      // 角色列表注入 properties panel 的候选角色下拉(应用隔离:仅本应用角色)
      try {
        const roles = await rolesApi.listByApp(data.appId)
        setDshRoleOptions(roles ?? [])
      } catch {
        setDshRoleOptions([])
      }
      // skill 选项注入 properties panel 的 skillRefs 多选:应用绑定了 SkillHub
      // namespace 才拉清单;未绑定/拉取失败静默降级为空选项,设计器仍可用
      if (appData?.skillhubNamespace) {
        try {
          const skills = await appsApi.listSkills(data.appId)
          setDshSkillOptions((skills ?? []).map(s => ({ value: s.slug, label: s.slug })))
        } catch {
          setDshSkillOptions([])
        }
      } else {
        setDshSkillOptions([])
      }
      // backend profile 活跃实例注入 properties panel 的 DSH backend task 下拉;
      // 拉取失败静默降级为空选项(发布校验兜底拦截空 URL)
      try {
        const profiles = await backendProfilesApi.list()
        setDshBackendProfileOptions(profiles ?? [])
      } catch {
        setDshBackendProfileOptions([])
      }
      // 组织树扁平化注入 properties panel 的"指定部门"下拉(到根路径显示);
      // 组织未启用或拉取失败降级为空选项(发布校验兜底拦截空部门)
      try {
        const tree = await orgUnitsApi.tree()
        setDshOrgUnitOptions(flattenOrgUnitTree(tree ?? []))
      } catch {
        setDshOrgUnitOptions([])
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载流程失败')
    }
  }, [workflowId, message])

  useEffect(() => {
    void load()
  }, [load])

  const submitEditMeta = async () => {
    if (!wf) return
    const values = await metaForm.validateFields()
    try {
      const updated = await workflowsApi.updateMeta(wf.id, values)
      setWf(updated)
      message.success('已更新流程 Meta')
      setEditMetaOpen(false)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败')
    }
  }

  const handleSaveBpmn = async () => {
    if (!wf) return
    setSaving(true)
    try {
      const updated = await workflowsApi.updateDraftBpmn(wf.id, { draftBpmnXml: bpmnXml })
      setWf(updated)
      setXmlDirty(false)
      setValidation(null)
      message.success('已保存草稿 BPMN')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleValidate = async () => {
    if (!wf) return
    if (xmlDirty) {
      message.warning('请先保存草稿再校验')
      return
    }
    setValidating(true)
    try {
      const result = await workflowsApi.validate(wf.id)
      setValidation(result)
      if (result.valid) {
        message.success('BPMN 校验通过')
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '校验失败')
    } finally {
      setValidating(false)
    }
  }

  const handlePublish = async () => {
    if (!wf) return
    try {
      const result = await workflowsApi.publish(wf.id)
      message.success(`已发布 (procdef=${result.procdefId})`)
      void load()
    } catch (e) {
      message.error(e instanceof Error ? e.message : '发布失败')
    }
  }

  const handleDisable = async () => {
    if (!wf) return
    try {
      const updated = await workflowsApi.disable(wf.id)
      setWf(updated)
      message.success('已停用')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '停用失败')
    }
  }

  const handleArchive = async () => {
    if (!wf) return
    try {
      await workflowsApi.archive(wf.id)
      message.success('已归档')
      navigate('/workflows')
    } catch (e) {
      message.error(e instanceof Error ? e.message : '归档失败')
    }
  }

  const handleStartInstance = () => {
    if (!wf) return
    navigate(`/instances/new?workflowId=${wf.id}`)
  }

  const canEditBpmn = wf?.status !== 'archived'
  const canPublish = wf?.status !== 'archived'
  const canDisable = wf?.status === 'published'
  const canArchive = wf?.status !== 'archived'
  const canStart = wf?.status === 'published'

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workflows')}>
          返回列表
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {wf?.name ?? '流程编辑'}
        </Typography.Title>
        {wf && (
          <Tag color={STATUS_COLOR[wf.status] ?? 'default'}>{STATUS_TEXT[wf.status] ?? wf.status}</Tag>
        )}
      </Space>

      <Descriptions
        bordered
        column={2}
        size="small"
        style={{ background: '#fff', marginBottom: 16 }}
        items={[
          { key: 'id', label: 'ID', children: wf?.id ?? '-' },
          { key: 'appId', label: '所属应用', children: app?.name ?? wf?.appId ?? '-' },
          { key: 'name', label: '名称', children: wf?.name ?? '-' },
          { key: 'description', label: '描述', children: wf?.description ?? '-' },
          {
            key: 'procdefId',
            label: '已发布 procdefId',
            children: wf?.publishedProcdefId ?? '-',
          },
          {
            key: 'deploymentId',
            label: 'deploymentId',
            children: wf?.publishedDeploymentId ?? '-',
          },
          {
            key: 'updatedAt',
            label: '更新时间',
            children: wf?.updatedAt ? dayjs(wf.updatedAt).format('YYYY-MM-DD HH:mm:ss') : '-',
          },
        ]}
      />

      <Space style={{ marginBottom: 16 }} wrap>
        <Button
          icon={<EditOutlined />}
          disabled={wf?.status === 'archived'}
          onClick={() => {
            if (!wf) return
            metaForm.setFieldsValue({ name: wf.name, description: wf.description ?? undefined })
            setEditMetaOpen(true)
          }}
        >
          编辑 Meta
        </Button>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={saving}
          disabled={!canEditBpmn || !xmlDirty}
          onClick={handleSaveBpmn}
        >
          保存草稿
        </Button>
        <Button
          icon={<CheckCircleOutlined />}
          loading={validating}
          disabled={!canEditBpmn || xmlDirty}
          onClick={handleValidate}
        >
          校验
        </Button>
        {canPublish && (
          <Popconfirm
            title="确认发布?"
            description="发布后将创建新的 Flowable deployment,旧版本被新版本覆盖"
            onConfirm={handlePublish}
          >
            <Button type="primary">发布</Button>
          </Popconfirm>
        )}
        {canDisable && (
          <Popconfirm title="确认停用?" onConfirm={handleDisable}>
            <Button danger>停用</Button>
          </Popconfirm>
        )}
        {canStart && (
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleStartInstance}
          >
            发起实例
          </Button>
        )}
        {canArchive && (
          <Popconfirm title="确认归档?此操作不可撤销" onConfirm={handleArchive}>
            <Button danger>归档</Button>
          </Popconfirm>
        )}
      </Space>

      {validation && (
        <Alert
          style={{ marginBottom: 16 }}
          showIcon
          type={validation.valid ? 'success' : 'error'}
          message={validation.valid ? '校验通过' : '校验失败'}
          description={
            validation.errors.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {validation.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            ) : null
          }
          closable
          onClose={() => setValidation(null)}
        />
      )}

      <Tabs
        defaultActiveKey="designer"
        items={[
          {
            key: 'designer',
            label: '图形设计器',
            children: (
              <>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>

                </Typography.Paragraph>
                <BpmnModeler
                  xml={bpmnXml}
                  readonly={!canEditBpmn}
                  onXmlChange={(next) => {
                    setBpmnXml(next)
                    setXmlDirty(true)
                  }}
                />
              </>
            ),
          },
          {
            key: 'xml',
            label: 'XML 源码',
            children: (
              <>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                  直接编辑 XML(调试用);dsh 扩展元素结构以引擎 DshBpmnExtensionParser 为准。
                  编辑后点击"保存草稿"。
                </Typography.Paragraph>
                <Input.TextArea
                  value={bpmnXml}
                  onChange={(e) => {
                    setBpmnXml(e.target.value)
                    setXmlDirty(true)
                  }}
                  rows={24}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                  disabled={!canEditBpmn}
                  placeholder={DEFAULT_BPMN_XML}
                />
              </>
            ),
          },
        ]}
      />

      <Modal
        title="编辑流程 Meta"
        open={editMetaOpen}
        onCancel={() => setEditMetaOpen(false)}
        onOk={submitEditMeta}
        destroyOnHidden
      >
        <Form form={metaForm} layout="vertical">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入流程名称' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            修改名称/描述仅影响治理元数据,不会同步已发布到 Flowable 的旧版本。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}
