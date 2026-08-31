package com.dsh.console.workflow;

import com.dsh.console.app.ApplicationService;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.security.AuthContext;
import com.dsh.console.workflow.dto.BpmnValidationResult;
import com.dsh.console.workflow.dto.CreateWorkflowRequest;
import com.dsh.console.workflow.dto.PublishResult;
import com.dsh.console.workflow.dto.UpdateBpmnXmlRequest;
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
 *   <li>草稿编辑:仅 draft / published 状态可保存 BPMN XML。</li>
 *   <li>发布前校验:BPMN XML 合法 + role_id 归属(spec §12.10 应用隔离不变量)。</li>
 *   <li>发布成功后:状态 → published,记 published_deployment_id / published_procdef_id。</li>
 *   <li>停用(status → disabled)和归档(status → archived)不允许新实例启动。</li>
 * </ul>
 */
@Service
public class WorkflowDefinitionService {

    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final ApplicationService applicationService;
    private final BpmnValidationService validationService;
    private final BpmnPublishService publishService;
    private final AuditService auditService;

    public WorkflowDefinitionService(WorkflowDefinitionJdbcRepository workflowRepository,
                                     ApplicationService applicationService,
                                     BpmnValidationService validationService,
                                     BpmnPublishService publishService,
                                     AuditService auditService) {
        this.workflowRepository = workflowRepository;
        this.applicationService = applicationService;
        this.validationService = validationService;
        this.publishService = publishService;
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

        // 2) 部署到 Flowable
        String deploymentName = wf.name() + " (workflow:" + workflowId + ")";
        PublishResult result = publishService.publish(wf.draftBpmnXml(), deploymentName);

        // 3) 更新本地状态
        workflowRepository.markPublished(workflowId, result.deploymentId(), result.procdefId(), publisherId);
        auditService.record("WORKFLOW_PUBLISH", "workflow_definition", null, publisherId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId(),
                "deploymentId", result.deploymentId(), "procdefId", result.procdefId()));
        return new PublishResult(workflowId, result.deploymentId(), result.procdefId());
    }

    /**
     * 停用流程定义(状态 → disabled,不允许新实例启动)。
     */
    @Transactional
    public WorkflowDefinitionDto disable(UUID workflowId, UUID disablerId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        workflowRepository.setStatus(workflowId, "disabled");
        auditService.record("WORKFLOW_DISABLE", "workflow_definition", null, disablerId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId()));
        return workflowRepository.findById(workflowId).orElseThrow();
    }

    /**
     * 归档流程定义(状态 → archived,终态)。
     */
    @Transactional
    public WorkflowDefinitionDto archive(UUID workflowId, UUID archiverId, AuthContext auth) {
        WorkflowDefinitionDto wf = getById(workflowId, auth);
        workflowRepository.setStatus(workflowId, "archived");
        auditService.record("WORKFLOW_ARCHIVE", "workflow_definition", null, archiverId,
            java.util.Map.of("workflowId", workflowId, "appId", wf.appId()));
        return workflowRepository.findById(workflowId).orElseThrow();
    }
}
