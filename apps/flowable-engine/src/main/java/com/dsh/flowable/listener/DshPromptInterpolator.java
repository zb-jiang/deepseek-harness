package com.dsh.flowable.listener;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * userPrompt 模板 {@code {{var.field}}} 插值(design 2026-09-01 §7;公共化供
 * user task 任务创建与 DSH backend task delegate 复用,取值入口由调用方注入)。
 *
 * <p>语义(两处调用方必须一致):
 * <ul>
 *   <li>根段从流程变量取,后续段深入 Map 字段;非 Map 中途断开视为缺失。</li>
 *   <li>值缺失(null 或路径断开)替换为「空」——变量未设置常见于分支跳过
 *       未走过的节点,保留占位符原文会把模板语法泄漏给模型与办理人。</li>
 *   <li>string 直接替换;其余类型(object/array/数字等)序列化为 JSON 文本
 *       嵌入;序列化失败保留原占位符(不抛异常,插值是尽力而为的展示层)。</li>
 * </ul>
 */
public final class DshPromptInterpolator {

    /** userPrompt 模板占位符 {@code {{var.field}}}。 */
    private static final Pattern PROMPT_PLACEHOLDER = Pattern.compile("\\{\\{([^}]+)}}");

    private DshPromptInterpolator() {
    }

    /**
     * 替换模板中全部 {@code {{var.field}}} 占位符。
     *
     * @param template       prompt 模板原文
     * @param variableLookup 变量根取值入口(user task 传 {@code delegateTask::getVariable},
     *                        backend delegate 传 {@code execution::getVariable})
     * @param objectMapper    object/array 的 JSON 序列化器
     * @return 插值后的 prompt
     */
    public static String interpolate(String template,
                                     Function<String, Object> variableLookup,
                                     ObjectMapper objectMapper) {
        Matcher matcher = PROMPT_PLACEHOLDER.matcher(template);
        StringBuilder sb = new StringBuilder();
        while (matcher.find()) {
            String path = matcher.group(1).trim();
            matcher.appendReplacement(
                sb, Matcher.quoteReplacement(resolvePlaceholder(path, variableLookup, objectMapper)));
        }
        matcher.appendTail(sb);
        return sb.toString();
    }

    /**
     * 解析点路径占位符:根段取变量,后续段深入 Map 字段;缺失→「空」,
     * string 直出,其余 JSON 序列化,序列化失败保留原占位符。
     */
    private static String resolvePlaceholder(String path,
                                             Function<String, Object> variableLookup,
                                             ObjectMapper objectMapper) {
        String[] segments = path.split("\\.");
        Object value = variableLookup.apply(segments[0]);
        for (int i = 1; i < segments.length && value != null; i++) {
            if (value instanceof Map<?, ?> map) {
                value = map.get(segments[i]);
            } else {
                value = null;
            }
        }
        if (value == null) {
            return "空";
        }
        if (value instanceof String s) {
            return s;
        }
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            return "{{" + path + "}}";
        }
    }
}
