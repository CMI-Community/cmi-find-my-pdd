import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Heart, ScanLine, ShieldCheck } from 'lucide-react';
import './pdd-help.css';

export function HelpPage() {
  return <div className="pdd-page pdd-help">
    <Link to="/" className="pdd-help-back"><ArrowLeft size={18} aria-hidden="true" />返回查询</Link>
    <header className="pdd-help-heading">
      <span>CMI Community · 公益包裹互助</span>
      <h1>如何使用 PDD404</h1>
      <p>丢了包裹，或多收了别人的包裹？不用注册，凭国内快递单号找到线索。</p>
    </header>

    <section className="pdd-help-section">
      <h2><span aria-hidden="true">1</span>先选你的情况</h2>
      <div className="pdd-help-modes">
        <Link to="/" className="pdd-help-mode"><h3>我丢件了</h3><p>查有没有人多收了你的包裹。</p><span>去查丢件<ArrowRight size={17} aria-hidden="true" /></span></Link>
        <Link to="/?mode=received" className="pdd-help-mode"><h3>我多收件了</h3><p>查有没有人在寻找这个包裹。</p><span>去查多收件<ArrowRight size={17} aria-hidden="true" /></span></Link>
      </div>
    </section>

    <section className="pdd-help-section">
      <h2><span aria-hidden="true">2</span>找到国内运输单号</h2>
      <p>在拼多多订单的物流详情里查看，或看快递面单上条形码旁的完整单号。</p>
      <p className="pdd-help-note">请填国内运输单号，不填订单编号、集运总单号或末端配送单号。复制完整号码，保留开头的0。</p>
    </section>

    <section className="pdd-help-section">
      <h2><span aria-hidden="true">3</span>输入单号，或用相机识别</h2>
      <p>已有单号？直接粘贴到输入框，点击“查询”。</p>
      <ol className="pdd-help-camera-steps">
        <li>点击“扫码”，允许网站使用相机。</li>
        <li>将整个运输条形码和两端白边放入框内，让黑白线条清楚。</li>
        <li>选择“拍照识别”或“实时扫码”。拍照没识别到，可重新拍；画面模糊时先移远，电脑仍模糊可用手机。</li>
        <li><strong>核对填入的单号，再手动点击“查询”。</strong></li>
      </ol>
      <p className="pdd-help-local"><ShieldCheck size={19} aria-hidden="true" />相机画面和拍照图片只在本机识别，不会上传。</p>
    </section>

    <section className="pdd-help-section">
      <h2><span aria-hidden="true">4</span>按查询结果继续</h2>
      <div className="pdd-help-result"><h3>找到相同单号的登记</h3><p>复制对方微信号或电话，主动联系，核对包裹信息后安排交还。匹配是一条线索，还需确认包裹归属。</p></div>
      <div className="pdd-help-result"><h3>暂未查到</h3><p>单号会加入下方待提交列表。可以继续添加，再一次填写本人联系方式，点击“确认挂失”或“全部提交”。<strong>页面确认登记成功后，才算正式保存。</strong></p><p>填写的微信或电话会展示给查询相同完整单号的另一方，用于联系与交还。</p></div>
      <div className="pdd-help-result"><h3>已经登记或查询失败</h3><p>已经登记的单号无需重复提交。查询失败时按页面提示重试；失败不等于没有匹配。</p></div>
    </section>

    <section className="pdd-help-section">
      <h2><span aria-hidden="true">5</span>保存回执，继续跟进</h2>
      <p>登记成功后，请截图保存回执。以后从<Link to="/local">本机记录</Link>查看、修改联系方式或撤回登记，也可以用原单号再次查询新线索。</p>
      <p>私密管理链接只留给自己。换设备或清理浏览器不会自动恢复凭证；请妥善保存。</p>
      <p>匹配后请主动联系对方，网站不会自动发送微信或短信。需要协助时，可查看页面底部的找货群和 CMI 小助手入口。</p>
      <Link to="/privacy" className="pdd-help-detail-link"><ShieldCheck size={18} aria-hidden="true" />查看隐私与使用说明<ArrowRight size={17} aria-hidden="true" /></Link>
    </section>

    <div className="pdd-help-ending"><p><Heart size={20} aria-hidden="true" />感谢每一条准确的登记，让包裹多一个回家的机会。</p><Link to="/" className="pdd-button pdd-primary pdd-full"><ScanLine size={19} aria-hidden="true" />返回首页，开始查询<ArrowRight size={18} aria-hidden="true" /></Link></div>
  </div>;
}

export default HelpPage;
