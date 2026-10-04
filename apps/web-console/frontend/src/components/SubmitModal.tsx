import { Modal, Spin } from 'antd'
import type { ModalProps } from 'antd'

interface SubmitModalProps extends ModalProps {
  /** 提交请求进行中:内容区覆盖 Spin 蒙版,OK 按钮转圈,并禁用 Cancel、右上角关闭、ESC 与点击蒙层关闭。 */
  submitting: boolean
  /** 提交中在蒙版中央展示的操作提示,按弹窗语义定制(如"正在上传文档…"),默认"提交中…"。 */
  submittingTip?: string
}

/**
 * 提交型模态框:确认按钮触发后台请求的等待期间,在内容区显示蒙版并屏蔽全部关闭途径
 * (Cancel、右上角 X、ESC、点击蒙层),防止重复提交或中途误关。其余用法与 antd Modal 一致。
 */
export function SubmitModal({ submitting, submittingTip = '提交中…', children, ...rest }: SubmitModalProps) {
  return (
    <Modal
      {...rest}
      confirmLoading={submitting}
      keyboard={!submitting}
      closable={!submitting}
      maskClosable={!submitting}
      cancelButtonProps={{ ...rest.cancelButtonProps, disabled: submitting }}
    >
      <Spin spinning={submitting} size="large" tip={submittingTip}>
        {children}
      </Spin>
    </Modal>
  )
}
