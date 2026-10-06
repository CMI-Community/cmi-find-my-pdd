import { HandHeart, Search } from 'lucide-react';
import type { PddMode, PddRegistration } from '../shared/waybill';
import lostDesktopScene from './assets/home-detectives-lost-desktop.webp';
import receivedDesktopScene from './assets/home-detectives-received-desktop.webp';
import lostMobileScene from './assets/home-detectives-lost-mobile.webp';
import receivedMobileScene from './assets/home-detectives-received-mobile.webp';

export const homeModeContent = {
  lost: {
    label: '找包裹',
    title: '我的拼多多快递去哪了？',
    titleLines: ['我的拼多多快递', '去哪了？'],
    inputHint: '输入或粘贴国内快递单号',
    queryLabel: '查找',
    icon: Search,
  },
  received: {
    label: '找失主',
    title: '你的拼多多包裹在我这儿！',
    titleLines: ['你的拼多多包裹', '在我这儿！'],
    inputHint: '输入或粘贴国内快递单号',
    queryLabel: '查找',
    icon: HandHeart,
  },
} as const;

export const receivedRegistrationThanks = '谢谢你帮忙登记，让找包裹的人多一条线索。';

const homeScenes = {
  lost: { desktop: lostDesktopScene, mobile: lostMobileScene },
  received: { desktop: receivedDesktopScene, mobile: receivedMobileScene },
} as const;

export function HomeModeHeading({ mode }: { mode: PddMode }) {
  const content = homeModeContent[mode];
  return <div className="pdd-heading" data-mode={mode}>
    {(['lost', 'received'] as const).flatMap(value => (['left', 'right'] as const).map(side => <picture key={value + '-' + side} className={'pdd-home-scene pdd-home-scene-' + value + ' pdd-home-scene-' + side} aria-hidden="true">
      <source media="(max-width:800px)" srcSet={homeScenes[value].mobile} />
      <img src={homeScenes[value].desktop} alt="" fetchPriority="high" decoding="async" />
    </picture>))}
    <h1>{content.titleLines[0]}<br /><span>{content.titleLines[1]}</span></h1>
  </div>;
}

export function HomeModeControls({ mode, disabled, onChange }: { mode: PddMode; disabled: boolean; onChange: (mode: PddMode) => void }) {
  return <div className="pdd-modes" role="group" aria-label="选择你的情况">
    {(['lost', 'received'] as const).map(value => {
      const Icon = homeModeContent[value].icon;
      return <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? 'selected' : ''} disabled={disabled} onClick={() => onChange(value)}>
        <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
        <span>{homeModeContent[value].label}</span>
      </button>;
    })}
  </div>;
}

export function ReceivedRegistrationThanks({ registrations }: { registrations: (PddRegistration | null)[] }) {
  if (!registrations.some(registration => registration?.mode === 'received')) return null;
  return <p className="pdd-registration-thanks" role="status"><HandHeart size={20} strokeWidth={1.8} aria-hidden="true" /><span>{receivedRegistrationThanks}</span></p>;
}
