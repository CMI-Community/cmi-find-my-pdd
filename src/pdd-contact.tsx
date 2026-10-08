import { useEffect, useId, useRef, useState } from 'react';
import { validatePddContact, type PddContact } from '../shared/waybill';
import './pdd-contact.css';

/** Format checks cannot establish that a WeChat account exists or is searchable. */
export function contactInputError(contact: PddContact, optional = false): string {
  const value = contact.value.trim();
  if (!value) return optional ? '' : `请填写${contact.kind === 'wechat' ? '微信号' : '电话号码'}。`;
  try { validatePddContact(contact); return ''; } catch { /* Explain the local field. */ }
  if (contact.kind === 'phone') return '请核对电话号码，可包含国家区号、空格或连字符。';
  if (/[^a-zA-Z0-9_-]/.test(value)) return '这可能是微信昵称，或多复制了文字。请填写个人主页“微信号：”后面的内容，不含中文、空格或表情。';
  if (value.length < 6) return '微信号至少需要6位。请到微信个人主页核对“微信号”一行。';
  if (value.length > 64) return '内容过长，请只复制个人主页“微信号：”后面的内容。';
  return '微信号可以字母或下划线 _ 开头。若填的是手机号，请将联系方式切换为“电话号码”。';
}

export function checkedContact(contact: PddContact): PddContact {
  const error = contactInputError(contact);
  if (error) throw new Error(error);
  return validatePddContact(contact);
}

export function ContactInput({ contact, onChange, disabled = false, optional = false }: {
  contact: PddContact; onChange: (contact: PddContact) => void; disabled?: boolean; optional?: boolean;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null), [touched, setTouched] = useState(false);
  const validation = contactInputError(contact, optional), error = touched ? validation : '';
  useEffect(() => { input.current?.setCustomValidity(validation); }, [validation]);
  useEffect(() => { setTouched(false); }, [contact.kind]);
  return <div className={'pdd-contact-entry' + (contact.kind === 'wechat' ? ' pdd-contact-entry-wechat' : '')}>
    <div className="pdd-contact-input">
      <label htmlFor={id}>{contact.kind === 'wechat' ? '您的微信号' : '您的电话号码'}{optional ? '（选填）' : ''}</label>
      <input ref={input} id={id} value={contact.value} type={contact.kind === 'phone' ? 'tel' : 'text'}
        maxLength={contact.kind === 'phone' ? 32 : 64} disabled={disabled} required={!optional}
        autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        placeholder={contact.kind === 'wechat' ? '填写“微信号”那一行，不是昵称' : '包含国家区号，如 +66…'}
        aria-invalid={error ? true : undefined} aria-describedby={[contact.kind === 'wechat' ? id + '-help' : '', error ? id + '-error' : ''].filter(Boolean).join(' ') || undefined}
        onChange={event => { event.currentTarget.setCustomValidity(contactInputError({ ...contact, value: event.target.value }, optional)); onChange({ ...contact, value: event.target.value }); }}
        onBlur={() => setTouched(true)}
        onInvalid={event => { event.preventDefault(); setTouched(true); const target = event.currentTarget; requestAnimationFrame(() => { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }); }} />
      {error && <p id={id + '-error'} className="pdd-contact-error" role="alert">{error}</p>}
      {contact.kind === 'wechat' && contact.value.trim().length > 20 && !validation && <p className="pdd-contact-hint">这个微信号较长，请从微信个人主页复制“微信号”一行，再核对一次。</p>}
    </div>
    {contact.kind === 'wechat' && <figure className="pdd-wechat-guide" id={id + '-help'}>
      <img src="/wechat-id-example.svg" width="440" height="178" alt="虚拟微信个人主页示例：头像旁显示昵称小禾，下一行的微信号 _demo_2026 被红圈标出，下面是地区。请填写红圈中微信号冒号后的内容。" />
      <figcaption>微信 → 我 → 点顶部头像栏，查看“微信号”一行。<strong>填红圈这一行，别填上面的昵称。</strong></figcaption>
    </figure>}
  </div>;
}
