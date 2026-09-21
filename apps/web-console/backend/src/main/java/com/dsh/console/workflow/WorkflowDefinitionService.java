package com.dsh.console.workflow;

import com.dsh.console.app.ApplicationService;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.security.AuthContext;
import com.dsh.console.workflow.dto.BpmnValidationResult;
import com.dsh.console.workflow.dto.CreateWorkflowRequest;
import com.dsh.console.workflow.dto.PublishResult;
import com.dsh.console.workflow.dto.UpdateBpmnXmlRequest;
import com.dsh.console.workflow.dto.UpdateWorkflowMetaRequest;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 流程定义业务编排。
 *
 * <p>V1 实现规则(spec §5.6 + §12.10 + §13.4):
 * <ul>
 *   <li>草稿编辑:draft / published / disabled 状态均可保存 BPMN XML;archived 为终态不可编辑。</li>
 *   <li>发布前校验:BPMN XML 合法 + role_id 归属且 active(spec §12.10 应用隔离不变量)。</li>
 *   <li>发布成功后:状态 → published,记 published_deployment_id / published_procdef_id。
 *       重新发布走 Flowable 版本化:运行中实例继续执行旧版本,无需清零。</li>
 *   <li>停用(status → disabled)和归档(status → archived):要求全部部署版本的
 *       运行中实例数为 0(按 procdef key 跨版本聚合),且归档后不允许新实例启动。</li>
 * </ul>
 */
@Service
public class WorkflowDefinitionService {

    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final ApplicationService applicationService;
    private final BpmnValidationService validationService;
    private final BpmnPublishService publishService;
    private final WorkflowInstanceGuard instanceGuard;
    private final AuditService auditService;

    public WorkflowDefinitionService(WorkflowDefinitionJdbcRepository workflowRepository,
                                     ApplicationService applicationService,
                                     BpmnValidationService validationService,
                                     BpmnPublishService publishService,
                                     WorkflowInstanceGuard instanceGuard,
                                     AuditService auditService) {
        this.workflowRepository = workflowRepository;
        this.applicationService = applicationService;
        this.validationService = validationService;
        this.publishService = publishService;
        this.instanceGuard = instanceGuard;
        this.auditService = auditService;
    }

    public WorkflowDefinitionDto getById(UUID workflowId, AuthContext auth) {
        WorkflowDefinitionDto wf = workflowRepository.findById(workflowId)
            .orElseThrow(() -> new NotFoundException("流程定义不存在: " + workflowId));
        applicationService.checkCanAccessApp(auth, wf.appId());
        return wf;
    }

    public List<WorkflowDefinitionDto> listByApp(UUID appId, AuthContext auth) {
        applicationService.checkCanAccessApp(auth, appId);
        return workflowRepository.listByApp(appId);
    }

    public List<WorkflowDefinitionDto> list(String statusFilter, int offset, int limit, AuthContext auth) {
        // system_admin 看全部;app_admin 只看自己管理应用下的流程定义
        if (auth.isSystemAdmin()) {
            return workflowRepository.list(statusFilter, offset, limit);
        }
        // app_admin:过滤出自己管理应用下的 workflow_definitions
        return workflowRepository.list(statusFilter, offset, limit).stream()
            .filter(wf -> {
                try {
                    applicationService.checkCanAccessApp(auth, wf.appId());
                    return true;
                } catch (Exception e) {
                    return false;
                }
            })
            .toList();
    }

    @Transactional
    public WorkflowDefinitionDto create(CreateWorkflowRequest request, UUID creatorId, AuthContext auth) {
        applicationService.checkCanAccessApp(auth, request.appId());
        UUID workflowId = workflowRepository.create(
            request.appId(), request.name(), request.description(), creatorId);
        auditService.record("WORKFLOW_CREATE", "workflow_definition", null, creatorId,
            java.util.Map.of("workflowId", workflowId, "appId", request.appId(),
                "name", request.name()));
        return workflowRepository.findById(workflowId).orElseThrow();
    }

    @Transactional
    public WorkflowDefinitionDto updateDraftBpmnXml(UUID workflowId, UpdateBpmnXmlRequest request,
                                                    UUID updaterId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        int rows = workflowRepository.updateDraftBpmnXml(workflowId, request.draftBpmnXml(), updaterId);
        if (rows == 0) {
            throw new IllegalStateException("保存草稿失败:流程定义状态不允许编辑(非 draft/published)");
        }
        auditService.record("WORKFLOW_UPDATE_DRAFT", "workflow_definition", null, updaterId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId()));
        return workflowRepository.findById(workflowId).orElseThrow();
    }

    /**
     * 修改流程定义元数据(name / description)。
     *
     * <p>归档状态(status = archived)为终态,不允许修改。
     */
    @Transactional
    public WorkflowDefinitionDto updateMeta(UUID workflowId, UpdateWorkflowMetaRequest request,
                                            UUID updaterId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        int rows = workflowRepository.updateMeta(workflowId, request.name(), request.description(), updaterId);
        if (rows == 0) {
            throw new IllegalStateException("更新失败:流程定义已归档或不存在");
        }
        auditService.record("WORKFLOW_UPDATE_META", "workflow_definition", null, updaterId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId(),
                "name", request.name()));
        return workflowRepository.findById(workflowId).orElseThrow();
    }

    /**
     * 校验 BPMN XML,但不发布(供前端预览校验错误)。
     */
    public BpmnValidationResult validateBpmn(UUID workflowId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        if (wf.draftBpmnXml() == null || wf.draftBpmnXml().isBlank()) {
            return BpmnValidationResult.fail("草稿 BPMN XML 为空");
        }
        return validationService.validate(wf.draftBpmnXml(), wf.appId());
    }

    /**
     * 发布:校验 BPMN → 部署到 Flowable → 更新本地状态。
     */
    @Transactional
    public PublishResult publish(UUID workflowId, UUID publisherId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        if (wf.draftBpmnXml() == null || wf.draftBpmnXml().isBlank()) {
            throw new IllegalStateException("草稿 BPMN XML 为空,无法发布");
        }

        // 1) 校验 dsh 元数据 + role_id 归属
        BpmnValidationResult validation = validationService.validate(wf.draftBpmnXml(), wf.appId());
        if (!validation.valid()) {
            throw new IllegalArgumentException(
                "BPMN 校验失败: " + String.join("; ", validation.errors()));
        }

        // 1.5) process key 查重:key 是历史实例归属反查的回退键,两个流程定义共用同一
        //      key 会让反查归错应用(fail loud,复制流程 XML 忘改 process id 是常见来源)
        String bpmnProcessKey = BpmnContextParser.parseProcessKey(wf.draftBpmnXml());
        workflowRepository.findByBpmnProcessKey(bpmnProcessKey)
            .filter(other -> !other.id().equals(workflowId))
            .ifPresent(other -> {
                throw new IllegalArgumentException("BPMN process key「" + bpmnProcessKey
                    + "」已被流程定义「" + other.name() + "」使用,请修改草稿的 process id");
            });

        // 2) 部署到 Flowable
        String deploymentName = wf.name() + " (workflow:" + workflowId + ")";
        PublishResult result = publishService.publish(wf.draftBpmnXml(), deploymentName);

        // 3) 更新本地状态 + 发布版 XML 快照(skill 归属聚合只认这份,setup guide §13.2);
        //    同时落 BPMN process key(跨发布版本稳定,历史实例归属反查的回退键)
        workflowRepository.markPublished(workflowId, result.deploymentId(), result.procdefId(),
            wf.draftBpmnXml(), bpmnProcessKey, publisherId);
        auditService.record("WORKFLOW_PUBLISH", "workflow_definition", null, publisherId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId(),
                "deploymentId", result.deploymentId(), "procdefId", result.procdefId()));
        return new PublishResult(workflowId, result.deploymentId(), result.procdefId());
    }

    /**
     * 停用流程定义(状态 → disabled,不允许新实例启动)。
     *
     * <p>守卫:全部部署版本无运行中实例(按 procdef key 跨版本聚合)。
     */
    @Transactional
    public WorkflowDefinitionDto disable(UUID workflowId, UUID disablerId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        int running = instanceGuard.runningInstanceCount(wf);
        if (running > 0) {
            throw new IllegalStateException(
                "流程「%s」尚有 %d 个运行中实例,不能停用(先等待实例结束或终止实例)".formatted(wf.name(), running));
        }
        workflowRepository.setStatus(workflowId, "disabled");
        auditService.record("WORKFLOW_DISABLE", "workflow_definition", null, disablerId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId()));
        return workflowRepository.findById(workflowId).orElseThrow();
    }

    /**
     * 归档流程定义(状态 → archived,终态)。
     *
     * <p>守卫:全部部署版本无运行中实例(按 procdef key 跨版本聚合)。
     */
    @Transactional
    public WorkflowDefinitionDto archive(UUID workflowId, UUID archiverId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        int running = instanceGuard.runningInstanceCount(wf);
        if (running > 0) {
            throw new IllegalStateException(
                "流程「%s」尚有 %d 个运行中实例,不能归档(先等待实例结束或终止实例)".formatted(wf.name(), running));
        }
        workflowRepository.setStatus(workflowId, "archived");
        auditService.record("WORKFLOW_ARCHIVE", "workflow_definition", null, archiverId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId()));
        return workflowRepository.findById(workflowId).orElseThrow();
    }
}
