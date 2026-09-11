package com.dsh.console.app;

import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.app.dto.CreateApplicationRequest;
import com.dsh.console.app.dto.UpdateApplicationRequest;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.security.AuthContext;
import com.dsh.console.skillhub.SkillHubRestClient;
import com.dsh.console.skillhub.dto.SkillHubSkillDto;
import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.workflow.BpmnValidationService;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 应用治理业务编排。
 *
 * <p>V1 角色边界:
 * <ul>
 *   <li>{@code system_admin}:全部应用 CRUD。</li>
 *   <li>{@code app_admin}:可创建应用,并可操作自己创建或被分配的应用。</li>
 * </ul>
 *
 * <p>校验在 {@link #checkCanAccessApp} 完成,由 Controller 调用。
 */
@Service
public class ApplicationService {

    private final ApplicationJdbcRepository appRepository;
    private final UserJdbcRepository userRepository;
    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final AuditService auditService;
    private final SkillHubRestClient skillHubRestClient;

    private static final String DEFAULT_ICON_BASE64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM1NTUiIHN0cm9rZS13aWR0aD0iMiI+PHJlY3QgeD0iMyIgeT0iMyIgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiByeD0iMiIvPjxjaXJjbGUgY3g9IjguNSIgY3k9IjguNSIgcj0iMS41Ii8+PHBhdGggZD0iTTIxIDE1bC01LTUtMTYgMTYiLz48L3N2Zz4=";

    public ApplicationService(ApplicationJdbcRepository appRepository,
                              UserJdbcRepository userRepository,
                              WorkflowDefinitionJdbcRepository workflowRepository,
                              AuditService auditService,
                              SkillHubRestClient skillHubRestClient) {
        this.appRepository = appRepository;
        this.userRepository = userRepository;
        this.workflowRepository = workflowRepository;
        this.auditService = auditService;
        this.skillHubRestClient = skillHubRestClient;
    }

    public ApplicationDto getById(UUID appId) {
        return appRepository.findById(appId)
            .orElseThrow(() -> new NotFoundException("应用不存在: " + appId));
    }

    public List<ApplicationDto> listForUser(AuthContext auth, String statusFilter, int offset, int limit) {
        if (auth.isSystemAdmin()) {
            return appRepository.list(statusFilter, offset, limit);
        }
        // app_admin 只看自己管理的应用
        return listManagedApps(auth.platformUserId());
    }

    /**
     * 查询指定用户管理的所有应用(用于 app_admin 数据隔离)。
     */
    public List<ApplicationDto> listManagedApps(UUID userId) {
        return appRepository.listByAdminUser(userId);
    }

    @Transactional
    public ApplicationDto create(CreateApplicationRequest request, UUID creatorId, boolean isSystemAdmin) {
        List<UUID> adminIds = new java.util.ArrayList<>(request.appAdminUserIds());
        if (!isSystemAdmin) {
            // app_admin 创建应用必须把自己加入管理员列表,确保能管理自己创建的应用
            if (!adminIds.contains(creatorId)) {
                adminIds.add(creatorId);
            }
        }
        // 校验所有 admin 用户存在且 active
        for (UUID adminId : adminIds) {
            userRepository.findById(adminId)
                .filter(u -> "active".equalsIgnoreCase(u.status()))
                .orElseThrow(() -> new IllegalArgumentException("管理员用户不存在或非 active: " + adminId));
        }
        String icon = (request.icon() == null || request.icon().isBlank())
            ? DEFAULT_ICON_BASE64 : request.icon();
        UUID appId = appRepository.create(
            request.name(),
            request.description(),
            icon,
            adminIds.toArray(new UUID[0]),
            creatorId);
        auditService.record("APP_CREATE", "application", null, creatorId,
            java.util.Map.of("appId", appId, "name", request.name()));
        return getById(appId);
    }

    @Transactional
    public ApplicationDto update(UUID appId, UpdateApplicationRequest request, UUID updaterId) {
        ApplicationDto current = getById(appId);
        // icon:null/blank 表示不更新,保留现有图标(缺省覆盖会把自定义图标重置为默认占位图)
        String icon = (request.icon() == null || request.icon().isBlank())
            ? current.icon() : request.icon();
        // null 表示不更新该字段;空数组才表示清空
        UUID[] adminIds = request.appAdminUserIds() == null
            ? null : request.appAdminUserIds().toArray(new UUID[0]);
        // skillhubNamespace:null 不更新;空串清除;与当前不同则先过存在性检查与引用覆盖守卫
        String skillhubNamespace = request.skillhubNamespace();
        if (skillhubNamespace != null) {
            String newNamespace = skillhubNamespace.isBlank() ? null : skillhubNamespace;
            if (!java.util.Objects.equals(newNamespace, current.skillhubNamespace())) {
                if (newNamespace != null && !skillHubRestClient.namespaceExists(newNamespace)) {
                    throw new IllegalArgumentException("SkillHub namespace 不存在: " + newNamespace);
                }
                ensureNamespaceChangeSafe(appId, newNamespace);
            }
        }
        int rows = appRepository.update(appId, request.name(), request.description(), icon,
            adminIds, skillhubNamespace);
        if (rows == 0) {
            throw new IllegalStateException("应用更新失败:应用不存在或已归档");
        }
        // Map.of 不允许 null 值;skillhubNamespace 为 null(本次未涉及)时省略审计字段
        java.util.Map<String, Object> auditDetail = new java.util.HashMap<>();
        auditDetail.put("appId", appId);
        auditDetail.put("name", request.name());
        if (skillhubNamespace != null) {
            auditDetail.put("skillhubNamespace", skillhubNamespace);
        }
        auditService.record("APP_UPDATE", "application", null, updaterId, auditDetail);
        return getById(appId);
    }

    /**
     * 换绑/清除 SkillHub namespace 的守卫:本应用未归档流程定义已引用的 skill
     * 必须能被目标 namespace 全量覆盖;清除绑定视为空覆盖,存在任何引用即拒绝。
     *
     * @param appId 目标应用
     * @param newNamespace 目标 namespace;null 表示清除绑定
     * @throws IllegalArgumentException 存在无法被新 namespace 覆盖的已引用 skill,
     *                                  或 SkillHub 清单读取失败
     */
    private void ensureNamespaceChangeSafe(UUID appId, String newNamespace) {
        // skill 名 → 引用它的流程名(未归档定义;草稿与已发布一并守护,发布前即拦截换绑)
        Map<String, List<String>> refsBySkill = new LinkedHashMap<>();
        workflowRepository.listByApp(appId).stream()
            .filter(wf -> !"archived".equals(wf.status()))
            .forEach(wf -> BpmnValidationService.collectSkillRefs(wf.draftBpmnXml())
                .forEach(skill -> refsBySkill
                    .computeIfAbsent(skill, k -> new java.util.ArrayList<>())
                    .add(wf.name())));
        if (refsBySkill.isEmpty()) {
            return;
        }
        if (newNamespace == null) {
            throw new IllegalArgumentException(
                "流程仍在引用 skill(%s),不能清除 SkillHub namespace(先移除流程中的 skill 引用)"
                    .formatted(String.join("、", refsBySkill.keySet())));
        }
        List<SkillHubSkillDto> available;
        try {
            available = skillHubRestClient.listNamespaceSkills(newNamespace);
        } catch (Exception e) {
            throw new IllegalArgumentException(
                "无法读取 SkillHub namespace 清单,绑定变更被拒绝: " + e.getMessage());
        }
        Set<String> slugs = available.stream()
            .map(SkillHubSkillDto::slug)
            .collect(Collectors.toSet());
        List<String> missing = refsBySkill.keySet().stream()
            .filter(skill -> !slugs.contains(skill))
            .collect(Collectors.toList());
        if (!missing.isEmpty()) {
            List<String> referencingWorkflows = refsBySkill.values().stream()
                .flatMap(List::stream)
                .distinct()
                .collect(Collectors.toList());
            throw new IllegalArgumentException(
                "skill %s 正被流程「%s」引用且不在 namespace 「%s」中,绑定变更被拒绝"
                    .formatted(String.join("、", missing),
                        String.join("、", referencingWorkflows), newNamespace));
        }
    }

    /**
     * 列应用绑定的 SkillHub namespace 下全部已发布 skill。
     *
     * @throws IllegalArgumentException 应用未配置 SkillHub namespace
     */
    public List<SkillHubSkillDto> listSkillHubSkills(UUID appId) {
        String namespace = getById(appId).skillhubNamespace();
        if (namespace == null || namespace.isBlank()) {
            throw new IllegalArgumentException("应用未配置 SkillHub namespace,请先在应用管理配置");
        }
        return skillHubRestClient.listNamespaceSkills(namespace);
    }

    /**
     * 归档应用(终态)。
     *
     * <p>守卫:应用下流程定义须全部归档(流程归档已保证其运行中实例清零,
     * 传递保证应用下无运行中实例)。
     */
    @Transactional
    public ApplicationDto archive(UUID appId, UUID archiverId) {
        List<String> notArchived = workflowRepository.listByApp(appId).stream()
            .filter(wf -> !"archived".equals(wf.status()))
            .map(wf -> "「" + wf.name() + "」(" + wf.status() + ")")
            .collect(Collectors.toList());
        if (!notArchived.isEmpty()) {
            throw new IllegalStateException(
                "应用下存在未归档的流程: %s(先归档全部流程再归档应用)"
                    .formatted(String.join("、", notArchived)));
        }
        int rows = appRepository.archive(appId, archiverId);
        if (rows == 0) {
            throw new IllegalStateException("应用归档失败:状态已是 archived");
        }
        auditService.record("APP_ARCHIVE", "application", null, archiverId,
            java.util.Map.of("appId", appId));
        return getById(appId);
    }

    /**
     * 校验当前用户是否能操作指定应用。
     *
     * <p>system_admin 全部能;app_admin 仅当 app_admin_user_ids 包含自己;否则抛 AccessDenied。
     */
    public void checkCanAccessApp(AuthContext auth, UUID appId) {
        if (auth.isSystemAdmin()) {
            return;
        }
        ApplicationDto app = getById(appId);
        if (app.appAdminUserIds() == null || !app.appAdminUserIds().contains(auth.platformUserId())) {
            throw new org.springframework.security.access.AccessDeniedException(
                "用户不是应用 " + appId + " 的管理员");
        }
    }
}
