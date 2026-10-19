import { Modal } from './ui'

export function NoHarnessPrompt({ onClose, onOpenHarnessSettings }: { onClose(): void; onOpenHarnessSettings(): void }) {
  return (
    <Modal
      title="没有检测到可用的内核"
      onClose={onClose}
      footer={<button type="button" className="button button--primary" onClick={onOpenHarnessSettings}>去设置</button>}
    >
      <p>Kim 没有找到 Pi、Prime Agent 或 Loom，安装其中一个即可开始。</p>
      <p>如果已经安装，可以在「设置 · 运行环境」里填写可执行文件路径，或安装后重新检测。</p>
    </Modal>
  )
}
