package com.dsh.flowable.listener;

import java.util.ArrayList;
import java.util.List;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.UserTask;
import org.flowable.validation.ProcessValidator;
import org.flowable.validation.ValidationError;
import org.flowable.validation.validator.Problems;
import org.flowable.validation.validator.ValidatorSet;

/**
 * 包装 Flowable 默认 {@link ProcessValidator},放行「多实例 collection 由 DSH 引擎补齐」
 * 场景下的 {@code flowable-multi-instance-missing-collection} 校验错误,其余校验结果原样透传。
 *
 * <p>为什么必须过滤:{@code BpmnParse.execute()} 先执行校验、后执行 parse handler,
 * 设计侧 BPMN 按产品语义不写 collection(见 CLAUDE.md「Human task 待办产品语义」:
 * 处理策略由多实例类型表达,办理人由引擎运行时计算),原始校验必然报错。
 *
 * <p>放行条件与 {@link DshBpmnParseHandler} 的补齐条件完全一致
 * ({@link DshBpmnParseHandler#engineProvidesCollection}):多实例 + 配了
 * candidateRoleId + 设计师未自配 loopCardinality/collection。
 * 不满足该条件的 missing-collection 错误照常报出,不误放行真正的模型错误。
 */
public class DshProcessValidator implements ProcessValidator {

    private final ProcessValidator delegate;

    public DshProcessValidator(ProcessValidator delegate) {
        this.delegate = delegate;
    }

    @Override
    public List<ValidationError> validate(BpmnModel bpmnModel) {
        List<ValidationError> errors = delegate.validate(bpmnModel);
        if (errors == null || errors.isEmpty()) {
            return errors;
        }
        List<ValidationError> result = new ArrayList<>(errors.size());
        for (ValidationError error : errors) {
            if (!suppress(bpmnModel, error)) {
                result.add(error);
            }
        }
        return result;
    }

    @Override
    public List<ValidatorSet> getValidatorSets() {
        return delegate.getValidatorSets();
    }

    private boolean suppress(BpmnModel bpmnModel, ValidationError error) {
        if (error.isWarning() || !Problems.MULTI_INSTANCE_MISSING_COLLECTION.equals(error.getProblem())) {
            return false;
        }
        UserTask userTask = DshBpmnParseHandler.findUserTask(bpmnModel, error.getActivityId());
        if (userTask == null) {
            return false;
        }
        return DshBpmnParseHandler.engineProvidesCollection(userTask, new DshBpmnExtensionParser().parse(userTask));
    }
}
