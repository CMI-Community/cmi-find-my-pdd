import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { HelpPage } from '../src/pdd-help';

function help() { return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/help'] }, createElement(HelpPage))); }

describe('PDD404 help page', () => {
  it('provides real navigation for both modes, local receipts and privacy without requesting registration', () => {
    const html = help();
    expect(html).toContain('<h1>如何使用 PDD404</h1>');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/?mode=received"');
    expect(html).toContain('href="/local"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('不用注册');
  });
  it('explains photo/manual query and separates local queued numbers from confirmed registration', () => {
    const html = help();
    expect(html).toContain('拍照识别');
    expect(html).toContain('开启自动扫码');
    expect(html).toContain('已拍照，正在识别');
    expect(html).toContain('核对填入的单号，再手动点击');
    expect(html).toContain('待提交列表');
    expect(html).toContain('页面确认登记成功后，才算正式保存');
    expect(html).not.toContain('自动查询');
  });
  it('sets truthful matching, contact-sharing and camera privacy expectations', () => {
    const html = help();
    expect(html).toContain('相机画面和拍照图片只在本机识别，不会上传');
    expect(html).toContain('还需确认包裹归属');
    expect(html).toContain('会展示给查询相同完整单号的另一方');
    expect(html).toContain('私密管理链接只留给自己');
    expect(html).toContain('不会自动发送微信或短信');
    expect(html).not.toContain('本站不保存任何个人信息');
  });
});
