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
  type CreateWorkflowRequest,
  type WorkflowDefinitionDto,
  workflowsApi,
} from '../api/workflows'
import { rolesApi } from '../api/roles'
import BpmnModeler from '../bpmn/BpmnModeler'
import { setDshRoleOptions } from '../bpmn/DshPropertiesProvider'

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
  const [editMetaOpen, setEditMetaOpen] = useState(false)
  const [metaForm] = Form.useForm<Pick<CreateWorkflowRequest, 'name' | 'description'>>()

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
      // 角色列表注入 properties panel 的候选角色下拉(应用隔离:仅本应用角色)
      try {
        const roles = await rolesApi.listByApp(data.appId)
        setDshRoleOptions(roles ?? [])
      } catch {
        setDshRoleOptions([])
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
    await metaForm.validateFields()
    try {
      // V1 视 meta 为创建时固化的不可变信息,如要改名请归档后重建。
      message.warning('V1 流程 meta 创建后不可修改;如需改名请归档后重建')
      setEditMetaOpen(false)
      void load()
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

  const canEditBpmn = wf?.status === 'draft' || wf?.status === 'disabled'
  const canPublish = wf?.status === 'draft' || wf?.status === 'disabled'
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
          { key: 'appId', label: '所属应用', children: wf?.appId ?? '-' },
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
          onClick={() => {
            if (!wf) return
            metaForm.setFieldsValue({ name: wf.name, description: wf.description ?? undefined })
            setEditMetaOpen(true)
          }}
        >
          查看 Meta
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
                  左侧画布拖拽建模;选中节点后在右侧面板配置:UserTask 看"DSH 人工节点配置"
                  (候选角色/处理策略/五要素/超时升级/SoD/路由),ServiceTask 看"DSH 自动节点配置"
                  (执行委托/异步)。修改后点击"保存草稿"。
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
        title="流程 Meta 信息"
        open={editMetaOpen}
        onCancel={() => setEditMetaOpen(false)}
        onOk={submitEditMeta}
        destroyOnHidden
      >
        <Form form={metaForm} layout="vertical">
          <Form.Item name="name" label="名称">
            <Input disabled />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} disabled />
          </Form.Item>
          <Typography.Paragraph type="warning" style={{ fontSize: 12 }}>
            V1 meta 创建后不可修改;如需改名请归档后重建。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  )
}
