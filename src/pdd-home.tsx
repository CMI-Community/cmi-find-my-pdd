import { Check, HandHeart, Search } from 'lucide-react';
import type { PddMode, PddRegistration } from '../shared/waybill';

export const homeModeContent = {
  lost: {
    label: '找包裹',
    title: '我的包裹去哪了？',
    description: '',
    inputHint: '输入你要找的包裹的国内快递单号',
    queryLabel: '查询错收登记',
    icon: Search,
  },
  received: {
    label: '找失主',
    title: '这个包裹，可能正有人在找。',
    description: '扫描面单上的国内快递单号，看看有没有人登记挂失。',
    inputHint: '输入手上这个包裹的国内快递单号',
    queryLabel: '查询挂失登记',
    icon: HandHeart,
  },
} as const;

export const receivedRegistrationThanks = '谢谢你帮忙登记，让找包裹的人多一条线索。';

export function HomeModeIntro({ mode, disabled, onChange }: { mode: PddMode; disabled: boolean; onChange: (mode: PddMode) => void }) {
  const content = homeModeContent[mode];
  return <>
    <p className="pdd-mode-guide">有别人的包裹在你手上？帮忙找找失主。</p>
    <div className="pdd-modes" role="group" aria-label="选择你的情况">
      {(['lost', 'received'] as const).map(value => {
        const Icon = homeModeContent[value].icon;
        return <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? 'selected' : ''} disabled={disabled} onClick={() => onChange(value)}>
          <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
          <span>{homeModeContent[value].label}</span>
          <Check className="pdd-mode-check" size={16} aria-hidden="true" />
        </button>;
      })}
    </div>
    <div className={'pdd-heading pdd-heading-' + mode}>
      <h1>{content.title}</h1>
      {content.description && <p>{content.description}</p>}
    </div>
  </>;
}

export function ReceivedRegistrationThanks({ registrations }: { registrations: (PddRegistration | null)[] }) {
  if (!registrations.some(registration => registration?.mode === 'received')) return null;
  return <p className="pdd-registration-thanks" role="status"><HandHeart size={20} strokeWidth={1.8} aria-hidden="true" /><span>{receivedRegistrationThanks}</span></p>;
}
