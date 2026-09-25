package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;
import com.dsh.flowable.repository.DshUserRepository;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 通知 delegate:发文流程的通知类节点(通知发起人/通知发文被否)共用,把通知内容落到流程实例日志。
 * BPMN: flowable:delegateExpression="${dshNotifyDelegate}"
 *
 * <p>通知对象取 {@code initiator}(系统注入 object:userId/name/email)的显示名,
 * name 缺失时按 userId 反查 platform_users;通知正文为标题附加会签意见(完成场景)
 * 或 AI 评审说明(被否场景)。后续接真实通知渠道(如 IM webhook)时在本类扩展投递实现。
 */
@Component("dshNotifyDelegate")
public class NotifyDelegate implements JavaDelegate {

    private final DshUserRepository userRepository;

    public NotifyDelegate(DshUserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    public void execute(DelegateExecution execution) {
        ProcessLog.log(execution, "通知发起人 {}: {}", resolveInitiatorName(execution), buildMessage(execution));
        execution.setVariable("lastNotifyActivity", execution.getCurrentActivityId());
    }

    /** 发起人显示名:优先 initiator.name,缺失时按 initiator.userId 反查,再缺失回退 userId。 */
    private String resolveInitiatorName(DelegateExecution execution) {
        Object initiator = execution.getVariable("initiator");
        if (initiator instanceof Map<?, ?> map) {
            Object name = map.get("name");
            if (name instanceof String s && !s.isBlank()) {
                return s;
            }
            Object userId = map.get("userId");
            if (userId instanceof String id && !id.isBlank()) {
                return userRepository.findDisplayNamesByAuthSubjects(List.of(id)).getOrDefault(id, id);
            }
        }
        return "未知";
    }

    /**
     * 通知正文:发文标题,附加会签意见(完成场景,{@code leaderOpinions} 逐条)或
     * AI 评审说明(被否场景,{@code reviewNotes})。被否时会签尚未执行、意见列表
     * 必为空,按数据形态自然分派,无需区分节点。
     */
    private String buildMessage(DelegateExecution execution) {
        Object title = execution.getVariable("title");
        StringBuilder sb = new StringBuilder("发文《").append(title == null ? "未命名" : title).append("》");
        Object opinions = execution.getVariable("leaderOpinions");
        if (opinions instanceof List<?> list && !list.isEmpty()) {
            for (int i = 0; i < list.size(); i++) {
                sb.append("\n  会签意见[").append(i + 1).append("]: ").append(list.get(i));
            }
            return sb.toString();
        }
        Object notes = execution.getVariable("reviewNotes");
        if (notes instanceof String s && !s.isBlank()) {
            sb.append("；评审说明: ").append(s);
        }
        return sb.toString();
    }
}
