package com.dsh.console.knowledge;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.knowledge.dto.KbAppSummaryDto;
import com.dsh.console.knowledge.dto.KbDocumentContentDto;
import com.dsh.console.knowledge.dto.KbDocumentDto;
import com.dsh.console.knowledge.dto.KbDocumentTextDto;
import com.dsh.console.knowledge.dto.KbFolderDto;
import com.dsh.console.knowledge.dto.KnowledgeBaseDto;
import com.dsh.console.security.AuthContext;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

/**
 * 知识库业务编排:应用级成员校验(全员平等读写)+ 文件夹树 + 文档上传/检索/下载/删除。
 *
 * <p>权限口径:system_admin 全通;应用管理员({@code app_admin_user_ids})可配置知识库
 * (开通/建删文件夹/上传/删除);应用 active 成员可进行内容访问与上传——管理员不必是成员,
 * 成员校验口径为「管理员 ∪ active 成员」,与 RLS(见 setup guide §12.2)一致。
 * 不做目录级 ACL。
 *
 * <p>上传把文件字节直接交给解析管线(不经 Storage 回读),Storage 只在请求线程访问。
 */
@Service
public class KnowledgeService {

    /** 全部知识库共用的 Storage 桶(setup guide §4.1 一次性手工预建),应用间以对象路径 {appId}/ 段隔离。 */
    private static final String KB_BUCKET = "kb-documents";

    private final KnowledgeJdbcRepository repository;
    private final ApplicationJdbcRepository appRepository;
    private final SupabaseStorageClient storageClient;
    private final KbParsePipeline parsePipeline;
    private final AuditService auditService;

    public KnowledgeService(KnowledgeJdbcRepository repository,
                            ApplicationJdbcRepository appRepository,
                            SupabaseStorageClient storageClient,
                            KbParsePipeline parsePipeline,
                            AuditService auditService) {
        this.repository = repository;
        this.appRepository = appRepository;
        this.storageClient = storageClient;
        this.parsePipeline = parsePipeline;
        this.auditService = auditService;
    }

    // ---------- 知识库开通 ----------

    /**
     * 查应用知识库,不存在则按需开通(写 knowledge_bases 行,登记公共 Storage 桶名)。
     *
     * <p>Storage 统一用公共桶 {@link #KB_BUCKET}:桶按 setup guide §4.1 一次性手工预建;
     * 治理 JDBC 连的是本地 PG,云端 storage schema 不可达,代码不做桶登记。
     * 应用间以对象路径 {@code {appId}/{docId}/...} 分段隔离。
     *
     * <p>开通属配置动作,仅 system_admin / 应用管理员可触发;成员的内容访问
     * 走 {@link #getKnowledgeBase}(KB 已存在时由管理员先行开通)。
     */
    @Transactional
    public KnowledgeBaseDto ensureKnowledgeBase(AuthContext auth, UUID appId) {
        checkAppAdminAccess(auth, appId);
        ApplicationDto app = appRepository.findById(appId)
            .orElseThrow(() -> new NotFoundException("应用不存在: " + appId));
        return repository.findKbByApp(appId).orElseGet(() -> {
            KnowledgeBaseDto kb = repository.insertKb(appId, app.name() + " 知识库", KB_BUCKET);
            auditService.record("KB_CREATE", "application", null, auth.platformUserId(),
                Map.of("appId", appId, "kbId", kb.id(), "storageBucket", KB_BUCKET));
            return kb;
        });
    }

    /**
     * 按知识库 id 取(校验访问权);员工端与工具链后续用此入口。
     */
    public KnowledgeBaseDto getKnowledgeBase(AuthContext auth, UUID kbId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        return kb;
    }

    /**
     * 按应用查知识库(成员可读,不开通):员工端待办会话的知识库选择器入口
     * (design 2026-09-11 §6 待办定位知识库)。未开通抛 NotFound,前端隐藏入口。
     */
    public KnowledgeBaseDto findKnowledgeBaseByApp(AuthContext auth, UUID appId) {
        KnowledgeBaseDto kb = repository.findKbByApp(appId)
            .orElseThrow(() -> new NotFoundException("应用未开通知识库: " + appId));
        checkAppMemberAccess(auth, kb.applicationId());
        return kb;
    }

    /**
     * 当前用户可见的知识库清单(system_admin 全部;其余为应用管理员 ∪
     * active 成员的应用):员工端工作空间上传「选应用」数据源。
     */
    public List<KbAppSummaryDto> listKbsForUser(AuthContext auth) {
        return auth.isSystemAdmin()
            ? repository.listAllKbs()
            : repository.listKbsForUser(auth.platformUserId(), auth.authSubject());
    }

    // ---------- 文件夹 ----------

    public List<KbFolderDto> listFolders(AuthContext auth, UUID kbId) {
        checkKbAccess(auth, kbId);
        return repository.listFolders(kbId);
    }

    @Transactional
    public KbFolderDto createFolder(AuthContext auth, UUID kbId, String name, UUID parentId) {
        checkKbAccess(auth, kbId);
        validateFolderName(name);
        UUID parent = parentId;
        String path;
        if (parent != null) {
            KbFolderDto parentFolder = requireFolder(kbId, parent);
            path = parentFolder.path() + "/" + name;
        } else {
            path = "/" + name;
        }
        try {
            KbFolderDto folder = repository.insertFolder(kbId, parent, name, path);
            auditService.record("KB_FOLDER_CREATE", "kb_folder", null, auth.platformUserId(),
                Map.of("kbId", kbId, "folderId", folder.id(), "path", path));
            return folder;
        } catch (DataIntegrityViolationException e) {
            throw new IllegalArgumentException("同级目录下已存在同名文件夹: " + name);
        }
    }

    /**
     * 重命名/移动文件夹(可同时),同步重算子树物化路径。
     *
     * <p>不支持移动到根(根级无层级差异,重命名即可;前端如需可删除重建)。
     */
    @Transactional
    public KbFolderDto updateFolder(AuthContext auth, UUID kbId, UUID folderId,
                                    String newName, UUID newParentId) {
        checkKbAccess(auth, kbId);
        KbFolderDto folder = requireFolder(kbId, folderId);
        if (newName == null && newParentId == null) {
            throw new IllegalArgumentException("name 与 parentId 至少给一个");
        }
        String name = newName != null ? newName : folder.name();
        validateFolderName(name);
        UUID parentId;
        String parentPath;
        if (newParentId != null) {
            if (newParentId.equals(folderId)) {
                throw new IllegalArgumentException("不能把文件夹移动到自己之下");
            }
            KbFolderDto target = requireFolder(kbId, newParentId);
            // 防环:目标父目录不能是自己的子树(含自身)
            if (target.path().equals(folder.path()) || target.path().startsWith(folder.path() + "/")) {
                throw new IllegalArgumentException("不能把文件夹移动到自己的子目录下");
            }
            parentId = target.id();
            parentPath = target.path();
        } else {
            parentId = folder.parentId();
            parentPath = folder.parentId() == null ? null
                : requireFolder(kbId, folder.parentId()).path();
        }
        String newPath = parentPath == null ? "/" + name : parentPath + "/" + name;
        try {
            repository.updateFolder(folderId, parentId, name, newPath);
            if (!newPath.equals(folder.path())) {
                repository.updateFolderSubtreePaths(kbId, folder.path(), newPath);
            }
        } catch (DataIntegrityViolationException e) {
            throw new IllegalArgumentException("同级目录下已存在同名文件夹: " + name);
        }
        auditService.record("KB_FOLDER_UPDATE", "kb_folder", null, auth.platformUserId(),
            Map.of("kbId", kbId, "folderId", folderId, "oldPath", folder.path(), "newPath", newPath));
        return requireFolder(kbId, folderId);
    }

    @Transactional
    public void deleteFolder(AuthContext auth, UUID kbId, UUID folderId) {
        checkKbAccess(auth, kbId);
        KbFolderDto folder = requireFolder(kbId, folderId);
        if (repository.folderHasChildren(kbId, folderId)) {
            throw new IllegalStateException("文件夹包含子文件夹,先删除子文件夹");
        }
        if (repository.folderHasDocuments(kbId, folderId)) {
            throw new IllegalStateException("文件夹包含文档,先删除或移出文档");
        }
        repository.deleteFolder(folderId);
        auditService.record("KB_FOLDER_DELETE", "kb_folder", null, auth.platformUserId(),
            Map.of("kbId", kbId, "folderId", folderId, "path", folder.path()));
    }

    // ---------- 文档 ----------

    /**
     * 列文档。folderId 为 null 表示根;recursive 含子树(根 + recursive = 全库);
     * kw 关键字检索(强制只返回 ready);parseStatus 过滤解析状态。全文不进列表载荷,给摘要窗口。
     */
    public List<KbDocumentDto> listDocuments(AuthContext auth, UUID kbId, UUID folderId,
                                             boolean recursive, String kw, String parseStatus) {
        checkKbAccess(auth, kbId);
        KbFolderDto folder = folderId == null ? null : requireFolder(kbId, folderId);
        List<KbDocumentRecord> docs = repository.listDocuments(kbId, folder, recursive, kw, parseStatus);
        Map<String, String> uploaderNames = repository.displayNamesByAuthSubjects(
            docs.stream().map(KbDocumentRecord::uploadedBy).collect(Collectors.toSet()));
        return docs.stream()
            .map(doc -> toDto(doc, kw, uploaderNames))
            .toList();
    }

    /**
     * 上传文档:预检同名 → Storage 上传(透传 JWT)→ 落 pending 元数据行 → 提交异步解析。
     *
     * <p>字节由 multipart 直接载入(上限 {@code KB_MAX_UPLOAD_MB}),管线消费后即释放。
     */
    @Transactional
    public KbDocumentDto uploadDocument(AuthContext auth, UUID kbId, UUID folderId, MultipartFile file) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        if (folderId != null) {
            requireFolder(kbId, folderId);
        }
        String name = sanitizeFileName(file.getOriginalFilename());
        if (file.isEmpty()) {
            throw new IllegalArgumentException("上传文件为空: " + name);
        }
        if (repository.documentNameExists(kbId, folderId, name)) {
            throw new IllegalArgumentException("同级目录下已存在同名文档: " + name);
        }
        byte[] content;
        try {
            content = file.getBytes();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("读取上传文件失败: " + name, e);
        }
        String contentType = file.getContentType() == null || file.getContentType().isBlank()
            ? "application/octet-stream" : file.getContentType();
        UUID docId = UUID.randomUUID();
        // Storage 对象 key 是 S3 风格 ASCII 白名单,中文文件名会被拒(InvalidKey);
        // 对象路径 {appId}/{docId}/document{ext} 在公共桶内按应用分段隔离,对象名只用
        // docId + ASCII 扩展名,显示名以元数据 name 为准(下载由前端按 name 命名)
        String storagePath = kb.applicationId() + "/" + docId + "/document" + storageExtension(name);
        KbDocumentRecord doc = new KbDocumentRecord(docId, kbId, folderId, name, contentType,
            content.length, storagePath, null, KbDocumentDto.STATUS_PENDING, null,
            auth.authSubject(), null, null);
        storageClient.upload(kb.storageBucket(), storagePath, content, contentType);
        KbDocumentRecord inserted = repository.insertDocument(doc);
        parsePipeline.submit(docId, name, content);
        auditService.record("KB_DOCUMENT_UPLOAD", "kb_document", null, auth.platformUserId(),
            Map.of("kbId", kbId, "docId", docId, "name", name, "sizeBytes", content.length));
        return toDto(inserted, null, repository.displayNamesByAuthSubjects(Set.of(auth.authSubject())));
    }

    /**
     * 下载文档原文(Storage 透传用户 JWT 取回)。
     */
    public KbDocumentContentDto downloadDocument(AuthContext auth, UUID kbId, UUID docId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        KbDocumentRecord doc = repository.findDocument(kbId, docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        byte[] content = storageClient.download(kb.storageBucket(), doc.storagePath());
        return new KbDocumentContentDto(docId, doc.name(), doc.contentType(), content);
    }

    /**
     * 读文档抽取全文(员工端 kb_read 工具):按 docId 直查,KB 归属从行内 kb_id
     * 推导后照常做成员校验;未解析完成返回 pending 状态由调用方呈现。
     */
    public KbDocumentTextDto readDocumentText(AuthContext auth, UUID docId) {
        KbDocumentRecord doc = repository.findDocumentById(docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        KnowledgeBaseDto kb = repository.findKb(doc.kbId())
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + doc.kbId()));
        checkAppMemberAccess(auth, kb.applicationId());
        return new KbDocumentTextDto(
            doc.id(), doc.kbId(), doc.name(), doc.textContent(), doc.parseStatus());
    }

    /**
     * 按文档 id 查元数据(员工端历史消息 KB 徽标):按 docId 直查,KB 归属从
     * 行内 kb_id 推导后照常做成员校验。
     */
    public KbDocumentDto getDocument(AuthContext auth, UUID docId) {
        KbDocumentRecord doc = repository.findDocumentById(docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        KnowledgeBaseDto kb = repository.findKb(doc.kbId())
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + doc.kbId()));
        checkAppMemberAccess(auth, kb.applicationId());
        return toDto(doc, null, repository.displayNamesByAuthSubjects(Set.of(doc.uploadedBy())));
    }

    @Transactional
    public void deleteDocument(AuthContext auth, UUID kbId, UUID docId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
        KbDocumentRecord doc = repository.findDocument(kbId, docId)
            .orElseThrow(() -> new NotFoundException("文档不存在: " + docId));
        // 先删 Storage 再删元数据行:Storage 删除失败(502)时行保留可重试
        storageClient.delete(kb.storageBucket(), doc.storagePath());
        repository.deleteDocument(docId);
        auditService.record("KB_DOCUMENT_DELETE", "kb_document", null, auth.platformUserId(),
            Map.of("kbId", kbId, "docId", docId, "name", doc.name()));
    }

    // ---------- 内部 ----------

    private KbFolderDto requireFolder(UUID kbId, UUID folderId) {
        return repository.findFolder(kbId, folderId)
            .orElseThrow(() -> new NotFoundException("文件夹不存在: " + folderId));
    }

    private void checkKbAccess(AuthContext auth, UUID kbId) {
        KnowledgeBaseDto kb = repository.findKb(kbId)
            .orElseThrow(() -> new NotFoundException("知识库不存在: " + kbId));
        checkAppMemberAccess(auth, kb.applicationId());
    }

    /**
     * 内容访问校验:system_admin / 应用管理员直通;其余须为 active 成员(口径同 RLS)。
     */
    private void checkAppMemberAccess(AuthContext auth, UUID appId) {
        if (auth.isSystemAdmin() || isAppAdmin(auth, appId)) {
            return;
        }
        if (!repository.isActiveMember(appId, auth.authSubject())) {
            throw new AccessDeniedException("用户不是应用 " + appId + " 的管理员或成员");
        }
    }

    /**
     * 配置动作校验(开通知识库):仅 system_admin / 应用管理员。
     */
    private void checkAppAdminAccess(AuthContext auth, UUID appId) {
        if (auth.isSystemAdmin()) {
            return;
        }
        if (!isAppAdmin(auth, appId)) {
            throw new AccessDeniedException("只有应用管理员可以配置知识库");
        }
    }

    private boolean isAppAdmin(AuthContext auth, UUID appId) {
        return appRepository.findById(appId)
            .map(app -> app.appAdminUserIds() != null
                && app.appAdminUserIds().contains(auth.platformUserId()))
            .orElse(false);
    }

    /**
     * Storage 对象扩展名:取文件名最后一个 '.' 之后、仅含 ASCII 字母数字的部分(小写),
     * 否则为空串——对象 key 不含用户输入的中文/特殊字符(S3 风格白名单),显示名以元数据为准。
     */
    private static String storageExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) {
            return "";
        }
        String ext = fileName.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        boolean asciiAlnum = ext.chars().allMatch(c -> (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
        return asciiAlnum ? "." + ext : "";
    }

    /**
     * 上传文件名:去掉浏览器可能携带的路径部分,校验非空、无分隔符、长度上限。
     */
    private static String sanitizeFileName(String original) {
        if (original == null || original.isBlank()) {
            throw new IllegalArgumentException("上传文件名为空");
        }
        String name = original.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        name = name.substring(slash + 1).trim();
        if (name.isBlank() || name.contains("/")) {
            throw new IllegalArgumentException("上传文件名非法: " + original);
        }
        if (name.length() > 200) {
            throw new IllegalArgumentException("文件名最长 200 字符");
        }
        return name;
    }

    private static void validateFolderName(String name) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("文件夹名不能为空");
        }
        if (name.contains("/")) {
            throw new IllegalArgumentException("文件夹名不能包含 '/'");
        }
        if (name.length() > 100) {
            throw new IllegalArgumentException("文件夹名最长 100 字符");
        }
    }

    /**
     * 行记录 → 列表 DTO:全文换摘要——kw 命中给命中窗口(前 80 后 160 字符),否则前 200 字符;
     * 上传者 id 按调用方批量解析出的显示名回填(缺失时为 null,前端降级显示短 id)。
     */
    private static KbDocumentDto toDto(KbDocumentRecord doc, String kw, Map<String, String> uploaderNames) {
        return new KbDocumentDto(doc.id(), doc.kbId(), doc.folderId(), doc.name(), doc.contentType(),
            doc.sizeBytes(), doc.parseStatus(), doc.parseError(), excerpt(doc.textContent(), kw),
            doc.uploadedBy(), uploaderNames.get(doc.uploadedBy()), doc.createdAt(), doc.updatedAt());
    }

    private static String excerpt(String text, String kw) {
        if (text == null || text.isBlank()) {
            return "";
        }
        if (kw != null && !kw.isBlank()) {
            int idx = text.toLowerCase(Locale.ROOT).indexOf(kw.toLowerCase(Locale.ROOT));
            if (idx >= 0) {
                int start = Math.max(0, idx - 80);
                int end = Math.min(text.length(), idx + kw.length() + 160);
                return (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length() ? "…" : "");
            }
        }
        return text.length() <= 200 ? text : text.substring(0, 200) + "…";
    }
}
