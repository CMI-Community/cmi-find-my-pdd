import { Barcode, ContactRound, HandHeart, Search } from 'lucide-react';
import type { PddLookupType, PddMode, PddRegistration } from '../shared/waybill';
import lostDesktopScene from './assets/home-detectives-lost-desktop.webp';
import receivedDesktopScene from './assets/home-detectives-received-desktop.webp';
import lostMobileScene from './assets/home-detectives-lost-mobile.webp';
import receivedMobileScene from './assets/home-detectives-received-mobile.webp';
import waybillDetective from './assets/lookup-detective-waybill.webp';
import recipientDetective from './assets/lookup-detective-recipient.webp';

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

export function LookupModeControls({ lookupType, disabled, onChange }: { lookupType: PddLookupType; disabled: boolean; onChange: (type: PddLookupType) => void }) {
  return <div className="pdd-lookup-picker" data-lookup={lookupType}>
    <div className="pdd-lookup-scene" aria-hidden="true">
      <img className="pdd-lookup-detective pdd-lookup-waybill" src={waybillDetective} alt="" decoding="async" /><img className="pdd-lookup-detective pdd-lookup-recipient" src={recipientDetective} alt="" decoding="async" />
      <div className="pdd-clue-label"><span className={'pdd-clue-name' + (lookupType === 'recipient' ? ' highlighted' : '')}><ContactRound size={11} /><span>收件人</span></span><i /><div className={'pdd-clue-barcode' + (lookupType === 'waybill' ? ' highlighted' : '')}><Barcode size={42} strokeWidth={1.5} /><span>国内快递单号</span></div></div>
    </div>
    <div className="pdd-lookup-tools"><div className="pdd-lookup-modes" role="group" aria-label="选择查找线索">
      {(['waybill', 'recipient'] as const).map(type => <button key={type} type="button" aria-pressed={lookupType === type} disabled={disabled} onClick={() => onChange(type)}>{type === 'waybill' ? '快递单号' : '收件人名'}</button>)}
    </div><p>{lookupType === 'waybill' ? '看条码下方的完整国内单号' : '看面单上的收件人名'}</p></div>
  </div>;
}

export function ReceivedRegistrationThanks({ registrations }: { registrations: (PddRegistration | null)[] }) {
  if (!registrations.some(registration => registration?.mode === 'received')) return null;
  return <p className="pdd-registration-thanks" role="status"><HandHeart size={20} strokeWidth={1.8} aria-hidden="true" /><span>{receivedRegistrationThanks}</span></p>;
}
