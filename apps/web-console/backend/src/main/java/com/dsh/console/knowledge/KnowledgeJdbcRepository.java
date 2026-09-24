package com.dsh.console.knowledge;

import com.dsh.console.knowledge.dto.KbAppSummaryDto;
import com.dsh.console.knowledge.dto.KbFolderDto;
import com.dsh.console.knowledge.dto.KnowledgeBaseDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * 知识库三张表({@code knowledge_bases} / {@code kb_folders} / {@code kb_documents},
 * local-pg-setup-guide §3.3)的数据访问。
 *
 * <p>连接角色为 postgres(表 owner),不受 RLS 限制,写权限由服务层成员校验兜底。
 */
@Repository
public class KnowledgeJdbcRepository {

    private final JdbcClient jdbcClient;

    public KnowledgeJdbcRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    // ---------- knowledge_bases ----------

    public Optional<KnowledgeBaseDto> findKb(UUID kbId) {
        return jdbcClient.sql("""
                SELECT id, application_id, name, storage_bucket, created_at
                FROM public.knowledge_bases WHERE id = :kbId
                """)
            .param("kbId", kbId)
            .query(KbRowMapper.KB_INSTANCE)
            .optional();
    }

    public Optional<KnowledgeBaseDto> findKbByApp(UUID appId) {
        return jdbcClient.sql("""
                SELECT id, application_id, name, storage_bucket, created_at
                FROM public.knowledge_bases WHERE application_id = :appId
                """)
            .param("appId", appId)
            .query(KbRowMapper.KB_INSTANCE)
            .optional();
    }

    public KnowledgeBaseDto insertKb(UUID appId, String name, String storageBucket) {
        return jdbcClient.sql("""
                INSERT INTO public.knowledge_bases (application_id, name, storage_bucket)
                VALUES (:appId, :name, :bucket)
                RETURNING id, application_id, name, storage_bucket, created_at
                """)
            .param("appId", appId)
            .param("name", name)
            .param("bucket", storageBucket)
            .query(KbRowMapper.KB_INSTANCE)
            .single();
    }

    /**
     * 当前用户是否为应用 active 成员(口径与 RLS 一致:成员关系 active 且平台用户 active)。
     */
    public boolean isActiveMember(UUID appId, String authSubject) {
        return Boolean.TRUE.equals(jdbcClient.sql("""
                SELECT EXISTS (
                  SELECT 1 FROM public.app_memberships m
                  JOIN public.platform_users pu ON pu.id = m.user_id
                  WHERE m.app_id = :appId AND m.status = 'active'
                    AND pu.status = 'active' AND pu.auth_subject = :authSubject
                )
                """)
            .param("appId", appId)
            .param("authSubject", authSubject)
            .query(Boolean.class)
            .single());
    }

    /**
     * 批量解析 auth_subject → 平台显示名(文档列表回填上传人;缺失的 subject 不在返回 Map 中)。
     */
    public Map<String, String> displayNamesByAuthSubjects(Collection<String> authSubjects) {
        if (authSubjects.isEmpty()) {
            return Map.of();
        }
        return jdbcClient.sql("""
                SELECT auth_subject, display_name FROM public.platform_users
                WHERE auth_subject IN (:subjects)
                """)
            .param("subjects", authSubjects)
            .query((rs, rowNum) -> Map.entry(rs.getString("auth_subject"), rs.getString("display_name")))
            .list()
            .stream()
            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    }

    /**
     * 列当前用户可见的知识库(应用管理员 ∪ active 成员的应用;不含 archived
     * 应用),联应用名按应用名排序。员工端「上传到知识库」选应用数据源。
     */
    public List<KbAppSummaryDto> listKbsForUser(UUID platformUserId, String authSubject) {
        return jdbcClient.sql("""
                SELECT kb.id AS kb_id, kb.application_id, kb.name AS kb_name, a.name AS app_name
                FROM public.knowledge_bases kb
                JOIN public.applications a ON a.id = kb.application_id AND a.status <> 'archived'
                WHERE :userId = ANY(a.app_admin_user_ids)
                   OR EXISTS (
                     SELECT 1 FROM public.app_memberships m
                     JOIN public.platform_users pu ON pu.id = m.user_id
                     WHERE m.app_id = kb.application_id AND m.status = 'active'
                       AND pu.status = 'active' AND pu.auth_subject = :authSubject
                   )
                ORDER BY a.name
                """)
            .param("userId", platformUserId)
            .param("authSubject", authSubject)
            .query((rs, rowNum) -> new KbAppSummaryDto(
                rs.getObject("kb_id", UUID.class),
                rs.getObject("application_id", UUID.class),
                rs.getString("app_name"),
                rs.getString("kb_name")))
            .list();
    }

    /**
     * 列全部知识库(system_admin;不含 archived 应用),按应用名排序。
     */
    public List<KbAppSummaryDto> listAllKbs() {
        return jdbcClient.sql("""
                SELECT kb.id AS kb_id, kb.application_id, kb.name AS kb_name, a.name AS app_name
                FROM public.knowledge_bases kb
                JOIN public.applications a ON a.id = kb.application_id AND a.status <> 'archived'
                ORDER BY a.name
                """)
            .query((rs, rowNum) -> new KbAppSummaryDto(
                rs.getObject("kb_id", UUID.class),
                rs.getObject("application_id", UUID.class),
                rs.getString("app_name"),
                rs.getString("kb_name")))
            .list();
    }

    // ---------- kb_folders ----------

    public List<KbFolderDto> listFolders(UUID kbId) {
        return jdbcClient.sql("""
                SELECT id, kb_id, parent_id, name, path, created_at
                FROM public.kb_folders WHERE kb_id = :kbId ORDER BY path
                """)
            .param("kbId", kbId)
            .query(KbRowMapper.FOLDER_INSTANCE)
            .list();
    }

    public Optional<KbFolderDto> findFolder(UUID kbId, UUID folderId) {
        return jdbcClient.sql("""
                SELECT id, kb_id, parent_id, name, path, created_at
                FROM public.kb_folders WHERE kb_id = :kbId AND id = :folderId
                """)
            .param("kbId", kbId)
            .param("folderId", folderId)
            .query(KbRowMapper.FOLDER_INSTANCE)
            .optional();
    }

    public KbFolderDto insertFolder(UUID kbId, UUID parentId, String name, String path) {
        return jdbcClient.sql("""
                INSERT INTO public.kb_folders (kb_id, parent_id, name, path)
                VALUES (:kbId, :parentId, :name, :path)
                RETURNING id, kb_id, parent_id, name, path, created_at
                """)
            .param("kbId", kbId)
            .param("parentId", parentId)
            .param("name", name)
            .param("path", path)
            .query(KbRowMapper.FOLDER_INSTANCE)
            .single();
    }

    /**
     * 更新文件夹自身行(name/parent_id/path),返回受影响行数(0 = 文件夹不存在)。
     */
    public int updateFolder(UUID folderId, UUID parentId, String name, String path) {
        return jdbcClient.sql("""
                UPDATE public.kb_folders
                SET parent_id = :parentId, name = :name, path = :path
                WHERE id = :folderId
                """)
            .param("folderId", folderId)
            .param("parentId", parentId)
            .param("name", name)
            .param("path", path)
            .update();
    }

    /**
     * 重算子树物化路径:oldPath 前缀替换为 newPath(移动与改名共用;调用方保证目标不落自己子树内)。
     */
    public int updateFolderSubtreePaths(UUID kbId, String oldPath, String newPath) {
        return jdbcClient.sql("""
                UPDATE public.kb_folders
                SET path = :newPath || substring(path from length(:oldPath) + 1)
                WHERE kb_id = :kbId AND path LIKE :oldPath || '/%'
                """)
            .param("kbId", kbId)
            .param("oldPath", oldPath)
            .param("newPath", newPath)
            .update();
    }

    public boolean folderHasChildren(UUID kbId, UUID folderId) {
        return Boolean.TRUE.equals(jdbcClient.sql(
                "SELECT EXISTS (SELECT 1 FROM public.kb_folders WHERE kb_id = :kbId AND parent_id = :folderId)")
            .param("kbId", kbId)
            .param("folderId", folderId)
            .query(Boolean.class)
            .single());
    }

    public boolean folderHasDocuments(UUID kbId, UUID folderId) {
        return Boolean.TRUE.equals(jdbcClient.sql(
                "SELECT EXISTS (SELECT 1 FROM public.kb_documents WHERE kb_id = :kbId AND folder_id = :folderId)")
            .param("kbId", kbId)
            .param("folderId", folderId)
            .query(Boolean.class)
            .single());
    }

    public void deleteFolder(UUID folderId) {
        jdbcClient.sql("DELETE FROM public.kb_folders WHERE id = :folderId")
            .param("folderId", folderId)
            .update();
    }

    // ---------- kb_documents ----------

    /**
     * 列文档。folder 为 null 时列根(folder_id IS NULL),recursive 时按物化路径前缀含整棵子树
     * (folder 为 null + recursive = 全库,员工端 kb_search/kb_list 工具依赖)。
     *
     * <p>kw 非空时强制只返回 ready(不变式:未解析完成的文档不得进入检索结果),
     * 对 name 与 text_content 做 ILIKE,并按 pg_trgm 的 similarity 相关性降序
     * (需 local-pg-setup-guide §3.3 的 pg_trgm 扩展与 GIN trgm 索引;未装扩展时检索报错);
     * parseStatus 参数可再过滤解析状态。
     */
    public List<KbDocumentRecord> listDocuments(UUID kbId, KbFolderDto folder,
                                                boolean recursive, String kw, String parseStatus) {
        StringBuilder sql = new StringBuilder("""
                SELECT id, kb_id, folder_id, name, content_type, size_bytes, storage_path,
                       text_content, parse_status, parse_error, uploaded_by, created_at, updated_at
                FROM public.kb_documents WHERE kb_id = :kbId
                """);
        if (folder == null) {
            if (!recursive) {
                sql.append(" AND folder_id IS NULL");
            }
        } else if (recursive) {
            sql.append("""
                     AND folder_id IN (
                       SELECT id FROM public.kb_folders
                       WHERE kb_id = :kbId AND (id = :folderId OR path LIKE :folderPath || '/%')
                     )
                    """);
        } else {
            sql.append(" AND folder_id = :folderId");
        }
        boolean search = kw != null && !kw.isBlank();
        if (search) {
            sql.append(" AND parse_status = 'ready'")
                .append(" AND (name ILIKE :kwLike OR text_content ILIKE :kwLike)");
        }
        if (parseStatus != null && !parseStatus.isBlank()) {
            sql.append(" AND parse_status = :parseStatus");
        }
        if (search) {
            sql.append(" ORDER BY GREATEST(similarity(name, :kw), similarity(text_content, :kw)) DESC NULLS LAST, name");
        } else {
            sql.append(" ORDER BY name");
        }

        var statement = jdbcClient.sql(sql.toString()).param("kbId", kbId);
        if (folder != null) {
            statement = statement.param("folderId", folder.id());
            if (recursive) {
                statement = statement.param("folderPath", folder.path());
            }
        }
        if (search) {
            statement = statement.param("kwLike", "%" + kw + "%").param("kw", kw);
        }
        if (parseStatus != null && !parseStatus.isBlank()) {
            statement = statement.param("parseStatus", parseStatus);
        }
        return statement.query(KbRowMapper.DOCUMENT_INSTANCE).list();
    }

    public Optional<KbDocumentRecord> findDocument(UUID kbId, UUID docId) {
        return jdbcClient.sql("""
                SELECT id, kb_id, folder_id, name, content_type, size_bytes, storage_path,
                       text_content, parse_status, parse_error, uploaded_by, created_at, updated_at
                FROM public.kb_documents WHERE kb_id = :kbId AND id = :docId
                """)
            .param("kbId", kbId)
            .param("docId", docId)
            .query(KbRowMapper.DOCUMENT_INSTANCE)
            .optional();
    }

    /**
     * 按文档 id 直查(不限 KB;kb_read 工具入参只有 docId,KB 归属从行内 kb_id 推导)。
     */
    public Optional<KbDocumentRecord> findDocumentById(UUID docId) {
        return jdbcClient.sql("""
                SELECT id, kb_id, folder_id, name, content_type, size_bytes, storage_path,
                       text_content, parse_status, parse_error, uploaded_by, created_at, updated_at
                FROM public.kb_documents WHERE id = :docId
                """)
            .param("docId", docId)
            .query(KbRowMapper.DOCUMENT_INSTANCE)
            .optional();
    }

    /**
     * 同层同名文档是否已存在(上传前预检;唯一索引仍是并发兜底)。
     */
    public boolean documentNameExists(UUID kbId, UUID folderId, String name) {
        var sql = new StringBuilder(
            "SELECT EXISTS (SELECT 1 FROM public.kb_documents WHERE kb_id = :kbId AND name = :name AND folder_id ");
        sql.append(folderId == null ? "IS NULL)" : "= :folderId)");
        var statement = jdbcClient.sql(sql.toString())
            .param("kbId", kbId)
            .param("name", name);
        if (folderId != null) {
            statement = statement.param("folderId", folderId);
        }
        return Boolean.TRUE.equals(statement.query(Boolean.class).single());
    }

    public KbDocumentRecord insertDocument(KbDocumentRecord doc) {
        return jdbcClient.sql("""
                INSERT INTO public.kb_documents
                  (id, kb_id, folder_id, name, content_type, size_bytes, storage_path,
                   parse_status, uploaded_by)
                VALUES (:id, :kbId, :folderId, :name, :contentType, :sizeBytes, :storagePath,
                        'pending', :uploadedBy)
                RETURNING id, kb_id, folder_id, name, content_type, size_bytes, storage_path,
                          text_content, parse_status, parse_error, uploaded_by, created_at, updated_at
                """)
            .param("id", doc.id())
            .param("kbId", doc.kbId())
            .param("folderId", doc.folderId())
            .param("name", doc.name())
            .param("contentType", doc.contentType())
            .param("sizeBytes", doc.sizeBytes())
            .param("storagePath", doc.storagePath())
            .param("uploadedBy", doc.uploadedBy())
            .query(KbRowMapper.DOCUMENT_INSTANCE)
            .single();
    }

    /**
     * 回写解析结果(pipeline 专用):ready 带全文,failed 带 parse_error,updated_at 一并刷新。
     */
    public void updateParseResult(UUID docId, String parseStatus, String textContent, String parseError) {
        jdbcClient.sql("""
                UPDATE public.kb_documents
                SET parse_status = :parseStatus, text_content = :textContent,
                    parse_error = :parseError, updated_at = now()
                WHERE id = :docId
                """)
            .param("docId", docId)
            .param("parseStatus", parseStatus)
            .param("textContent", textContent)
            .param("parseError", parseError)
            .update();
    }

    public void deleteDocument(UUID docId) {
        jdbcClient.sql("DELETE FROM public.kb_documents WHERE id = :docId")
            .param("docId", docId)
            .update();
    }

    /**
     * 三张表共用的行映射器集合。
     */
    static class KbRowMapper {

        static final RowMapper<KnowledgeBaseDto> KB_INSTANCE = (rs, rowNum) -> mapKb(rs);
        static final RowMapper<KbFolderDto> FOLDER_INSTANCE = (rs, rowNum) -> mapFolder(rs);
        static final RowMapper<KbDocumentRecord> DOCUMENT_INSTANCE = (rs, rowNum) -> mapDocument(rs);

        private static KnowledgeBaseDto mapKb(ResultSet rs) throws SQLException {
            return new KnowledgeBaseDto(
                rs.getObject("id", UUID.class),
                rs.getObject("application_id", UUID.class),
                rs.getString("name"),
                rs.getString("storage_bucket"),
                rs.getObject("created_at", java.time.OffsetDateTime.class));
        }

        private static KbFolderDto mapFolder(ResultSet rs) throws SQLException {
            return new KbFolderDto(
                rs.getObject("id", UUID.class),
                rs.getObject("kb_id", UUID.class),
                rs.getObject("parent_id", UUID.class),
                rs.getString("name"),
                rs.getString("path"),
                rs.getObject("created_at", java.time.OffsetDateTime.class));
        }

        private static KbDocumentRecord mapDocument(ResultSet rs) throws SQLException {
            return new KbDocumentRecord(
                rs.getObject("id", UUID.class),
                rs.getObject("kb_id", UUID.class),
                rs.getObject("folder_id", UUID.class),
                rs.getString("name"),
                rs.getString("content_type"),
                rs.getLong("size_bytes"),
                rs.getString("storage_path"),
                rs.getString("text_content"),
                rs.getString("parse_status"),
                rs.getString("parse_error"),
                rs.getString("uploaded_by"),
                rs.getObject("created_at", java.time.OffsetDateTime.class),
                rs.getObject("updated_at", java.time.OffsetDateTime.class));
        }
    }
}
