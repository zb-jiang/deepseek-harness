import {
  App,
  Button,
  Checkbox,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Tree,
  Typography,
  Upload,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { DataNode } from 'antd/es/tree'
import type { UploadFile, UploadProps } from 'antd'
import type { RcFile } from 'antd/es/upload'
import {
  FileDoneOutlined,
  FileSyncOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  MoreOutlined,
  RedoOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type ChunkParams,
  type KbDocumentDto,
  type KbFolderDto,
  type KnowledgeBaseDto,
  kbApi,
} from '../api/kb'
import { SubmitModal } from '../components/SubmitModal'

const PARSE_STATUS_META: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  pending: { color: 'processing', label: '解析中', icon: <FileSyncOutlined /> },
  ready: { color: 'success', label: '就绪', icon: <FileDoneOutlined /> },
  failed: { color: 'error', label: '失败', icon: null },
}

/** 上传来源白名单(与后端 DocumentParser 一致):文本/图片/Tika 族,白名单外后端拒绝。 */
const SUPPORTED_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'log', 'json',
  'png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff', 'webp',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'html', 'htm', 'epub',
]

/** chunk 分隔符预设(值为真实字符;自定义经 Select 输入)。 */
const SEPARATOR_PRESETS = [
  { value: '\n\n', label: '空行(段落)' },
  { value: '\n', label: '换行' },
  { value: '。', label: '句号' },
  { value: '；', label: '分号' },
  { value: ' ', label: '空格' },
]

function isSupportedFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return false
  return SUPPORTED_EXTENSIONS.includes(name.substring(dot + 1).toLowerCase())
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function shortId(id: string | null): string {
  if (!id) return '-'
  return id.slice(0, 8)
}

const ROOT_KEY = 'root'

/** 文档表轮询间隔:存在解析中(pending)文档时 3s 一查,全部就绪/失败后停止。 */
const PENDING_POLL_MS = 3000

/**
 * 应用详情「知识库」页签:左侧文件夹树 + 右侧文档表(上传/搜索/下载/删除)。
 *
 * <p>数据语义对齐后端 REST(设计文档 §5):folderId 缺省为根;kw 检索只返回
 * 解析 ready 的文档;文件夹删除仅限空文件夹;移动不支持到根目录。
 */
export default function KnowledgeTab({ appId }: { appId: string }) {
  const { message, modal } = App.useApp()

  const [kb, setKb] = useState<KnowledgeBaseDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [folders, setFolders] = useState<KbFolderDto[]>([])
  const [selectedKey, setSelectedKey] = useState<string>(ROOT_KEY)

  const [docs, setDocs] = useState<KbDocumentDto[]>([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [kw, setKw] = useState('')
  const [recursive, setRecursive] = useState(false)
  const [parseStatusFilter, setParseStatusFilter] = useState<string | undefined>(undefined)

  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [createFolderForm] = Form.useForm<{ name: string }>()
  const [renameFolderTarget, setRenameFolderTarget] = useState<KbFolderDto | null>(null)
  const [renameFolderForm] = Form.useForm<{ name: string }>()
  const [moveFolderTarget, setMoveFolderTarget] = useState<KbFolderDto | null>(null)
  const [moveFolderParent, setMoveFolderParent] = useState<string | undefined>(undefined)
  // 新建/重命名/移动三个文件夹弹窗互斥打开,共用提交中状态
  const [folderSaving, setFolderSaving] = useState(false)

  /** 上传对话框(多文件 + chunk 参数;确认后逐个提交,后端串行入队解析)。 */
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([])
  const [uploadForm] = Form.useForm<ChunkParams>()
  /** 重新解析对话框(预填文档当前 chunk 参数,可修改后重跑全管线)。 */
  const [reparseTarget, setReparseTarget] = useState<KbDocumentDto | null>(null)
  const [reparseForm] = Form.useForm<ChunkParams>()
  const [reparsing, setReparsing] = useState(false)

  const kbId = kb?.id ?? null

  const currentFolderId = selectedKey === ROOT_KEY ? null : selectedKey
  const currentFolderName =
    selectedKey === ROOT_KEY ? '根目录' : (folders.find(f => f.id === selectedKey)?.name ?? '根目录')

  const loadFolders = useCallback(async (id: string) => {
    try {
      setFolders(await kbApi.listFolders(id))
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载文件夹失败')
    }
  }, [message])

  const loadDocs = useCallback(
    async (id: string, folderId: string | null, search: string, recursiveFlag: boolean, status?: string) => {
      setDocsLoading(true)
      try {
        setDocs(
          await kbApi.listDocuments(id, {
            ...(folderId ? { folderId } : {}),
            recursive: recursiveFlag,
            ...(search.trim() ? { kw: search.trim() } : {}),
            ...(status ? { parseStatus: status } : {}),
          }),
        )
      } catch (e) {
        message.error(e instanceof Error ? e.message : '加载文档列表失败')
      } finally {
        setDocsLoading(false)
      }
    },
    [message],
  )

  // 页签挂载:开通/查知识库 → 加载文件夹 + 根目录文档
  useEffect(() => {
    if (!appId) return
    let cancelled = false
    ;(async () => {
      try {
        const kbData = await kbApi.ensureByApp(appId)
        if (cancelled) return
        setKb(kbData)
        setFolders(await kbApi.listFolders(kbData.id))
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : '加载知识库失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [appId])

  // kb / 目录 / 检索条件变化 → 重查文档
  useEffect(() => {
    if (!kbId) return
    void loadDocs(kbId, currentFolderId, kw, recursive, parseStatusFilter)
  }, [kbId, currentFolderId, kw, recursive, parseStatusFilter, loadDocs])

  // 存在解析中(pending)文档时轮询刷新,全部落定后停止
  const hasPending = docs.some(d => d.parseStatus === 'pending')
  useEffect(() => {
    if (!hasPending || !kbId) return
    const timer = setInterval(() => {
      void loadDocs(kbId, currentFolderId, kw, recursive, parseStatusFilter)
    }, PENDING_POLL_MS)
    return () => clearInterval(timer)
  }, [hasPending, kbId, currentFolderId, kw, recursive, parseStatusFilter, loadDocs])

  // ---------- 文件夹树 ----------

  const folderMenuItems = () => [
    { key: 'rename', label: '重命名' },
    { key: 'move', label: '移动' },
    { key: 'delete', label: '删除', danger: true },
  ]

  const handleFolderMenu = (folder: KbFolderDto, key: string) => {
    if (key === 'rename') {
      setRenameFolderTarget(folder)
      renameFolderForm.setFieldsValue({ name: folder.name })
    } else if (key === 'move') {
      setMoveFolderTarget(folder)
      setMoveFolderParent(undefined)
    } else if (key === 'delete') {
      modal.confirm({
        title: `删除文件夹「${folder.name}」?`,
        content: '仅允许删除空文件夹(不含子文件夹和文档)。',
        okButtonProps: { danger: true },
        onOk: async () => {
          if (!kbId) return
          try {
            await kbApi.deleteFolder(kbId, folder.id)
            if (selectedKey === folder.id) setSelectedKey(ROOT_KEY)
            await loadFolders(kbId)
          } catch (e) {
            message.error(e instanceof Error ? e.message : '删除失败')
          }
        },
      })
    }
  }

  const renderFolderTitle = (folder: KbFolderDto, selected: boolean) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        borderRadius: 6,
        paddingInline: 2,
      }}
    >
      <FolderOutlined
        style={{ color: selected ? '#2f54eb' : '#91caff', fontSize: 14, flexShrink: 0 }}
      />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: selected ? '#1d39c4' : undefined,
          fontWeight: selected ? 600 : 400,
        }}
      >
        {folder.name}
      </span>
      <Dropdown
        menu={{ items: folderMenuItems(), onClick: ({ key }) => handleFolderMenu(folder, key) }}
        trigger={['click']}
      >
        <Button
          className="kb-folder-more"
          type="text"
          size="small"
          icon={<MoreOutlined style={{ color: '#8c8c8c' }} />}
          onClick={e => e.stopPropagation()}
          style={{
            opacity: 0,
            transition: 'opacity 0.15s',
            marginLeft: 'auto',
            flexShrink: 0,
          }}
        />
      </Dropdown>
    </span>
  )

  const buildTreeNodes = (parentId: string | null, selectedId: string): DataNode[] =>
    folders
      .filter(f => (f.parentId ?? null) === parentId)
      .map(f => ({
        key: f.id,
        title: renderFolderTitle(f, f.id === selectedId),
        children: buildTreeNodes(f.id, selectedId),
      }))

  const treeData = useMemo<DataNode[]>(
    () => [
      {
        key: ROOT_KEY,
        title: (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontWeight: 600,
              color: selectedKey === ROOT_KEY ? '#1d39c4' : '#262626',
            }}
          >
            {selectedKey === ROOT_KEY ? (
              <FolderOpenOutlined style={{ color: '#2f54eb', fontSize: 14 }} />
            ) : (
              <FolderOutlined style={{ color: '#91caff', fontSize: 14 }} />
            )}
            根目录
          </span>
        ),
        children: buildTreeNodes(null, selectedKey),
      },
    ],
    [folders, selectedKey],
  )

  // ---------- 文档表 ----------

  const refreshAll = useCallback(async () => {
    if (!kbId) return
    await Promise.all([loadFolders(kbId), loadDocs(kbId, currentFolderId, kw, recursive, parseStatusFilter)])
  }, [kbId, currentFolderId, kw, recursive, parseStatusFilter, loadFolders, loadDocs])

  // ---------- 上传与重新解析 ----------

  /** 上传对话框文件列表:选择期校验扩展名(白名单外拒绝并提示),不自动上传。 */
  const uploadSelectProps: UploadProps = {
    multiple: true,
    beforeUpload: (_file, fileList) => {
      const invalid = fileList.filter(f => !isSupportedFile(f.name))
      if (invalid.length > 0) {
        message.warning(`不支持的格式: ${invalid.map(f => f.name).join('、')}(仅支持文本/图片/pdf/office 文件)`)
      }
      return false
    },
    fileList: uploadFileList,
    onChange: ({ fileList }) => {
      setUploadFileList(fileList.filter(f => isSupportedFile(f.name)))
    },
    onRemove: (file) => {
      setUploadFileList(prev => prev.filter(f => f.uid !== file.uid))
    },
  }

  // ---------- 文件夹弹窗提交(新建/重命名/移动互斥打开,共用 folderSaving) ----------

  const submitCreateFolder = async () => {
    if (!kbId) return
    const { name } = await createFolderForm.validateFields()
    setFolderSaving(true)
    try {
      await kbApi.createFolder(kbId, { name, ...(currentFolderId ? { parentId: currentFolderId } : {}) })
      setCreateFolderOpen(false)
      await loadFolders(kbId)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败')
    } finally {
      setFolderSaving(false)
    }
  }

  const submitRenameFolder = async () => {
    if (!kbId || !renameFolderTarget) return
    const { name } = await renameFolderForm.validateFields()
    setFolderSaving(true)
    try {
      await kbApi.updateFolder(kbId, renameFolderTarget.id, { name })
      setRenameFolderTarget(null)
      await loadFolders(kbId)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '重命名失败')
    } finally {
      setFolderSaving(false)
    }
  }

  const submitMoveFolder = async () => {
    if (!kbId || !moveFolderTarget) return
    if (!moveFolderParent) {
      message.warning('请选择目标父文件夹')
      return
    }
    setFolderSaving(true)
    try {
      await kbApi.updateFolder(kbId, moveFolderTarget.id, { parentId: moveFolderParent })
      setMoveFolderTarget(null)
      await loadFolders(kbId)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '移动失败')
    } finally {
      setFolderSaving(false)
    }
  }

  /** 确认上传:逐个提交(后端各自入队,串行解析),单个失败不打断后续。 */
  const handleUploadSubmit = async () => {
    if (!kbId) return
    const files = uploadFileList
      .map(f => f.originFileObj)
      .filter((f): f is RcFile => f instanceof File)
    if (files.length === 0) {
      message.warning('请先选择文件')
      return
    }
    const params = await uploadForm.validateFields()
    setUploading(true)
    let success = 0
    const failures: string[] = []
    for (const file of files) {
      try {
        await kbApi.upload(kbId, file, currentFolderId, params)
        success += 1
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : '上传失败'}`)
      }
    }
    setUploading(false)
    if (success > 0) {
      message.success(`${success} 个文档上传成功,后台解析中(解析队列串行处理,可稍后刷新查看状态)`)
    }
    if (failures.length > 0) {
      message.error(`上传失败: ${failures.join(';')}`)
    }
    setUploadOpen(false)
    setUploadFileList([])
    uploadForm.resetFields()
    await loadDocs(kbId, currentFolderId, kw, recursive, parseStatusFilter)
  }

  const openReparse = (doc: KbDocumentDto) => {
    reparseForm.setFieldsValue({
      chunkMaxSize: doc.chunkMaxSize,
      chunkOverlap: doc.chunkOverlap,
      chunkSeparator: doc.chunkSeparator,
    })
    setReparseTarget(doc)
  }

  /** 确认重新解析:重走抽取 → chunk → embedding 全管线,旧 chunk 在完成时整篇覆盖。 */
  const handleReparseSubmit = async () => {
    if (!kbId || !reparseTarget) return
    const params = await reparseForm.validateFields()
    setReparsing(true)
    try {
      await kbApi.reparse(kbId, reparseTarget.id, params)
      message.success(`「${reparseTarget.name}」已重新入队解析`)
      setReparseTarget(null)
      await loadDocs(kbId, currentFolderId, kw, recursive, parseStatusFilter)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '重新解析失败')
    } finally {
      setReparsing(false)
    }
  }

  const handleDownload = async (doc: KbDocumentDto) => {
    if (!kbId) return
    try {
      const blob = await kbApi.download(kbId, doc.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = doc.name
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '下载失败')
    }
  }

  const handleDeleteDoc = async (doc: KbDocumentDto) => {
    if (!kbId) return
    try {
      await kbApi.deleteDocument(kbId, doc.id)
      message.success(`「${doc.name}」已删除`)
      await loadDocs(kbId, currentFolderId, kw, recursive, parseStatusFilter)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const columns: ColumnsType<KbDocumentDto> = [
    {
      title: '文档名',
      dataIndex: 'name',
      ellipsis: true,
      render: (_, doc) => (
        <Tooltip title={doc.textExcerpt ? `摘要:${doc.textExcerpt}` : undefined}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FileDoneOutlined style={{ color: '#8c8c8c', fontSize: 14, flexShrink: 0 }} />
            <span style={{ color: '#262626' }}>{doc.name}</span>
          </span>
        </Tooltip>
      ),
    },
    { title: '大小', dataIndex: 'sizeBytes', width: 90, render: formatSize },
    { title: '上传人', dataIndex: 'uploaderName', width: 100, render: (_, doc) => doc.uploaderName ?? shortId(doc.uploadedBy) },
    {
      title: '解析状态',
      dataIndex: 'parseStatus',
      width: 110,
      render: (status: string, doc) => {
        const meta = PARSE_STATUS_META[status] ?? { color: 'default', label: status, icon: null }
        const tag = (
          <Tag color={meta.color} icon={meta.icon ?? undefined} style={{ borderRadius: 4 }}>
            {meta.label}
          </Tag>
        )
        return doc.parseError ? <Tooltip title={doc.parseError}>{tag}</Tooltip> : tag
      },
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 150,
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      render: (_, doc) => (
        <Space size={4}>
          <Tooltip title={doc.parseStatus === 'pending' ? '解析进行中,完成后可重新解析' : '重新抽取 → 拆 chunk → 生成向量,可调整 chunk 参数'}>
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 4 }}
              disabled={doc.parseStatus === 'pending'}
              icon={<RedoOutlined />}
              onClick={() => openReparse(doc)}
            >
              重新解析
            </Button>
          </Tooltip>
          <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={() => void handleDownload(doc)}>
            下载
          </Button>
          <Popconfirm title={`删除「${doc.name}」?`} onConfirm={() => void handleDeleteDoc(doc)}>
            <Button type="link" size="small" danger style={{ paddingInline: 4 }}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // ---------- 渲染 ----------

  if (loadError) {
    return <div style={{ color: '#cf1322', padding: 16 }}>{loadError}</div>
  }
  if (!kb) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin tip="加载知识库…" />
      </div>
    )
  }

  const toolbar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '12px 16px',
        background: '#fff',
        border: '1px solid #f0f0f0',
        borderRadius: '8px 8px 0 0',
        borderBottom: 'none',
      }}
    >
      <Button
        type="primary"
        icon={<UploadOutlined />}
        onClick={() => {
          setUploadFileList([])
          uploadForm.resetFields()
          setUploadOpen(true)
        }}
      >
        上传文档
      </Button>
      <Button
        icon={<FolderAddOutlined />}
        onClick={() => {
          createFolderForm.resetFields()
          setCreateFolderOpen(true)
        }}
      >
        新建文件夹
      </Button>
      <Tooltip title="上传/新建文件夹的目标位置,在左侧目录树中点击切换">
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 10px',
            background: '#eef3ff',
            borderRadius: 12,
            fontSize: 12,
            color: '#1d39c4',
            maxWidth: 220,
          }}
        >
          <FolderOpenOutlined style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentFolderName}
          </span>
        </span>
      </Tooltip>
      <div style={{ flex: 1 }} />
      <Input
        allowClear
        prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
        placeholder="在当前文件夹内搜索"
        style={{ width: 220 }}
        onPressEnter={e => setKw((e.target as HTMLInputElement).value)}
        onChange={(e) => {
          if (!e.target.value) setKw('')
        }}
      />
      <Checkbox checked={recursive} onChange={e => setRecursive(e.target.checked)}>
        含子文件夹
      </Checkbox>
      <Select
        allowClear
        placeholder="解析状态"
        style={{ width: 120 }}
        value={parseStatusFilter}
        onChange={v => setParseStatusFilter(v)}
        options={[
          { value: 'pending', label: '解析中' },
          { value: 'ready', label: '就绪' },
          { value: 'failed', label: '失败' },
        ]}
      />
      <Tooltip title="刷新">
        <Button icon={<ReloadOutlined />} onClick={() => void refreshAll()} />
      </Tooltip>
    </div>
  )

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* 左侧:文件夹树卡片 */}
      <div
        style={{
          width: 260,
          flexShrink: 0,
          background: '#fff',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          padding: '12px 8px',
          maxHeight: 'calc(100vh - 320px)',
          overflow: 'auto',
        }}
        className="kb-folder-panel"
      >
        <div
          style={{
            padding: '0 8px 8px',
            fontSize: 12,
            color: '#8c8c8c',
            letterSpacing: '0.05em',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>文件夹</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {folders.length} 个
          </Typography.Text>
        </div>
        <Tree
          blockNode
          defaultExpandAll
          selectedKeys={[selectedKey]}
          onSelect={(keys) => {
            if (keys.length > 0) setSelectedKey(String(keys[0]))
          }}
          treeData={treeData}
        />
      </div>

      {/* 右侧:工具栏 + 文档表,卡片式整体容器 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {toolbar}
        <Table<KbDocumentDto>
          rowKey="id"
          size="small"
          loading={docsLoading}
          columns={columns}
          dataSource={docs}
          pagination={{ pageSize: 20, showTotal: t => `共 ${t} 个文档` }}
          locale={{ emptyText: '当前文件夹暂无文档,点击「上传文档」添加' }}
          style={{
            background: '#fff',
            border: '1px solid #f0f0f0',
            borderRadius: '0 0 8px 8px',
          }}
        />
      </div>

      <style>{`
        .kb-folder-panel .ant-tree-node-content-wrapper {
          display: inline-flex;
          align-items: center;
          border-radius: 6px;
          transition: background-color 0.2s;
        }
        .kb-folder-panel .ant-tree-node-content-wrapper:hover {
          background: #f5f8ff;
        }
        .kb-folder-panel .ant-tree-node-selected {
          background: #eef3ff !important;
        }
        .kb-folder-panel .kb-folder-more {
          opacity: 0;
        }
        .kb-folder-panel .ant-tree-node-content-wrapper:hover .kb-folder-more,
        .kb-folder-panel .ant-tree-node-selected .kb-folder-more {
          opacity: 1;
        }
      `}</style>

      <SubmitModal
        title="新建文件夹"
        open={createFolderOpen}
        onCancel={() => setCreateFolderOpen(false)}
        onOk={submitCreateFolder}
        submitting={folderSaving}
        destroyOnClose
      >
        <Form form={createFolderForm} layout="vertical">
          <Form.Item label="父文件夹">
            <Input value={currentFolderName} disabled />
          </Form.Item>
          <Form.Item
            name="name"
            label="文件夹名"
            rules={[
              { required: true, message: '请输入文件夹名' },
              { max: 100, message: '最长 100 字符' },
            ]}
          >
            <Input placeholder="不能包含 '/',同级不能重名" />
          </Form.Item>
        </Form>
      </SubmitModal>

      <SubmitModal
        title={`重命名「${renameFolderTarget?.name ?? ''}」`}
        open={renameFolderTarget !== null}
        onCancel={() => setRenameFolderTarget(null)}
        onOk={submitRenameFolder}
        submitting={folderSaving}
        destroyOnClose
      >
        <Form form={renameFolderForm} layout="vertical">
          <Form.Item
            name="name"
            label="新名称"
            rules={[
              { required: true, message: '请输入新名称' },
              { max: 100, message: '最长 100 字符' },
            ]}
          >
            <Input />
          </Form.Item>
        </Form>
      </SubmitModal>

      <SubmitModal
        title={`移动「${moveFolderTarget?.name ?? ''}」`}
        open={moveFolderTarget !== null}
        onCancel={() => setMoveFolderTarget(null)}
        onOk={submitMoveFolder}
        submitting={folderSaving}
        destroyOnClose
      >
        <Select
          style={{ width: '100%' }}
          placeholder="选择目标父文件夹(不支持移动到根目录)"
          value={moveFolderParent}
          onChange={v => setMoveFolderParent(v)}
          options={folders
            .filter(f => f.id !== moveFolderTarget?.id)
            .map(f => ({ value: f.id, label: f.path }))}
        />
      </SubmitModal>

      <SubmitModal
        title={`上传文档到「${currentFolderName}」`}
        open={uploadOpen}
        onCancel={() => !uploading && setUploadOpen(false)}
        onOk={() => void handleUploadSubmit()}
        okText={`上传 ${uploadFileList.length > 0 ? `(${uploadFileList.length})` : ''}`}
        submitting={uploading}
        submittingTip={`正在上传 ${uploadFileList.length > 0 ? uploadFileList.length : ''} 个文档…`}
        destroyOnClose
      >
        <Form form={uploadForm} layout="vertical" initialValues={{ chunkMaxSize: 1000, chunkOverlap: 150, chunkSeparator: '\n\n' }}>
          <Form.Item label="文件(可多选;仅支持文本 / 图片 / pdf / office 文件)">
            <Upload.Dragger {...uploadSelectProps}>
              <p className="ant-upload-drag-icon"><UploadOutlined /></p>
              <p className="ant-upload-text">点击或拖拽文件到此处</p>
              <p className="ant-upload-hint">上传后进入解析队列:抽取文本 → 拆分 chunk → 生成 embedding 向量,完成后可检索</p>
            </Upload.Dragger>
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
            chunk 拆分参数(影响向量检索粒度;留空使用服务端默认值)
          </Typography.Text>
          <Space size="large" style={{ display: 'flex' }} wrap>
            <Form.Item
              name="chunkMaxSize"
              label="最大尺寸(字符)"
              style={{ marginBottom: 0 }}
              rules={[{ type: 'number', min: 100, max: 8000, message: '100~8000' }]}
            >
              <InputNumber min={100} max={8000} style={{ width: 140 }} placeholder="1000" />
            </Form.Item>
            <Form.Item
              name="chunkOverlap"
              label="相邻重叠(字符)"
              style={{ marginBottom: 0 }}
              rules={[{ type: 'number', min: 0, max: 4000, message: '0~4000 且小于最大尺寸/2' }]}
            >
              <InputNumber min={0} max={4000} style={{ width: 140 }} placeholder="150" />
            </Form.Item>
            <Form.Item name="chunkSeparator" label="分隔符" style={{ marginBottom: 0 }}>
              <Select
                style={{ width: 160 }}
                allowClear
                showSearch
                options={SEPARATOR_PRESETS}
                placeholder="空行(段落)"
              />
            </Form.Item>
          </Space>
        </Form>
      </SubmitModal>

      <SubmitModal
        title={`重新解析「${reparseTarget?.name ?? ''}」`}
        open={reparseTarget !== null}
        onCancel={() => setReparseTarget(null)}
        onOk={() => void handleReparseSubmit()}
        submitting={reparsing}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          从存储回读原文,重走「抽取文本 → 拆分 chunk → 生成 embedding 向量」全管线;旧 chunk 在解析完成时整篇覆盖。
          {reparseTarget?.parseStatus === 'failed' && reparseTarget.parseError && (
            <>上次失败原因:{reparseTarget.parseError}</>
          )}
        </Typography.Paragraph>
        <Form form={reparseForm} layout="vertical">
          <Space size="large" style={{ display: 'flex' }} wrap>
            <Form.Item
              name="chunkMaxSize"
              label="最大尺寸(字符)"
              rules={[{ type: 'number', min: 100, max: 8000, message: '100~8000' }]}
            >
              <InputNumber min={100} max={8000} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item
              name="chunkOverlap"
              label="相邻重叠(字符)"
              rules={[{ type: 'number', min: 0, max: 4000, message: '0~4000 且小于最大尺寸/2' }]}
            >
              <InputNumber min={0} max={4000} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="chunkSeparator" label="分隔符">
              <Select
                style={{ width: 160 }}
                allowClear
                showSearch
                options={SEPARATOR_PRESETS}
              />
            </Form.Item>
          </Space>
        </Form>
      </SubmitModal>
    </div>
  )
}
