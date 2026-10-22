/** Small badge helpers shared by layout components. */
import type { Tone } from '../../lib/labels';
import { connectionPhaseLabel, connectionPhaseTone } from '../../lib/labels';
import type { ConnectionPhase } from '../../state/snapshot';

export function connectionBadgeProps(phase: ConnectionPhase): { label: string; tone: Tone; title: string } {
  return {
    label: `连接：${connectionPhaseLabel(phase)}`,
    tone: connectionPhaseTone(phase),
    title: phase === 'connected' ? 'SSE 事件流已连接；状态仍以服务端快照为准。' : '连接异常时使用快照轮询兜底；不会伪造业务状态。',
  };
}
