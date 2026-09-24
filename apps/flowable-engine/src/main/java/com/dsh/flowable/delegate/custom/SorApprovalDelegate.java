package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;

import java.util.HashMap;
import java.util.Map;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 登记审批:把当前审批节点的结论写进 SOR 审批记录(规格书 §7.5,幂等键=流程实例+节点+审批人),
 * 并联动迁移单据状态(§6):reject → rejected;最后审批节点通过 → approved(正式批准);
 * 其余审批节点通过 → ongoing(任一人审批过即流转中)。
 * BPMN: flowable:delegateExpression="${sorApprovalDelegate}",挂 R3/PT1M 重试。
 * 本 delegate 不调状态端点,迁移由 SOR 在落库时联动完成。
 * 结论变量读取顺序:财务验票节点写 financeVerified,审批节点写 approvalResult;
 * financeVerified 优先——审批变量在流程上下文里残留,存在性判断只对 financeVerified 可靠。
 */
@Component("sorApprovalDelegate")
public class SorApprovalDelegate implements JavaDelegate {

    private final RestClient sorClient;

    public SorApprovalDelegate(@Value("${sor.base-url}") String baseUrl,
                               @Value("${sor.service-key}") String serviceKey) {
        this.sorClient = RestClient.builder().baseUrl(baseUrl)
            .defaultHeader("X-Service-Key", serviceKey).build();
    }

    @Override
    public void execute(DelegateExecution execution) {
        boolean financeVerifiedPresent = execution.hasVariable("financeVerified")
            && execution.getVariable("financeVerified") != null;
        boolean isFinanceVerify = financeVerifiedPresent;
        String decision = isFinanceVerify
            ? (Boolean.TRUE.equals(execution.getVariable("financeVerified")) ? "approve" : "reject")
            : String.valueOf(execution.getVariable("approvalResult"));
        String comment = isFinanceVerify
            ? String.valueOf(execution.getVariable("financeNotes"))
            : String.valueOf(execution.getVariable("approvalComment"));
        Map<String, Object> request = new HashMap<>();
        request.put("processInstanceId", execution.getProcessInstanceId());
        request.put("activityId", execution.getCurrentActivityId());
        request.put("decision", decision);
        // 联动迁移目标(§6):最后审批节点(财务复核)通过 → approved(正式批准);其余 → ongoing;
        // reject 不传,SOR 固定迁移 rejected
        if ("approve".equals(decision)) {
            request.put("targetStatus", isFinanceVerify ? "approved" : "ongoing");
        }
        request.put("comment", comment);
        request.put("approverId", String.valueOf(execution.getVariable("approvalApproverId")));
        request.put("approverName", String.valueOf(execution.getVariable("approvalApproverName")));
        ProcessLog.log(execution, "登记审批请求 decision判定 财务验票变量存在 {} financeVerified {} approvalResult {}",
            financeVerifiedPresent, execution.getVariable("financeVerified"),
            execution.hasVariable("approvalResult") ? execution.getVariable("approvalResult") : "<未写>");
        ProcessLog.log(execution, "登记审批请求体 {}", request);
        Map<String, Object> sorResponse = sorClient.post()
            .uri("/api/expenses/{id}/approval-records", execution.getVariable("expenseId"))
            .body(request)
            .retrieve().body(Map.class);
        // SOR 响应 data.duplicated=true 表示幂等重放(记录已存在,不迁移状态)——排查"记录在但状态不动"的关键信号
        ProcessLog.log(execution, "登记审批完成 单据 {} 结论 {} 审批人 {} SOR响应 {}",
            execution.getVariable("expenseId"), decision,
            execution.getVariable("approvalApproverName"), sorResponse);
        // SOR 迁移成功后回写流程变量:{{expenseStatus}} 的 prompt 插值在任务创建时快照,
        // 不回写则后续节点(出纳打款)看到的仍是「读取报销单」写入的 opened
        String newStatus = "reject".equals(decision) ? "rejected"
            : (isFinanceVerify ? "approved" : "ongoing");
        execution.setVariable("expenseStatus", newStatus);
    }
}