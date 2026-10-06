import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Heart, ScanLine, ShieldCheck } from 'lucide-react';
import './pdd-help.css';

export function HelpPage() {
  return <div className="pdd-page pdd-help">
    <Link to="/" className="pdd-help-back"><ArrowLeft size={18} aria-hidden="true" />返回查询</Link>
    <header className="pdd-help-heading">
      <h1>如何使用 PDD404</h1>
      <p>不用注册，按下面六步查询或登记包裹。</p>
    </header>

    <section className="pdd-help-section" aria-labelledby="pdd-help-steps-title">
      <h2 id="pdd-help-steps-title">操作步骤</h2>
      <ol className="pdd-help-steps">
        <li>根据你的情况，选择“<Link to="/">我丢件了</Link>”或“<Link to="/?mode=received">我错收件了</Link>”。</li>
        <li>在订单物流详情或快递面单上，找到完整的国内快递单号。</li>
        <li>将单号粘贴到输入框，或点击“扫码”、允许相机后点击“拍照识别”填入单号。</li>
        <li>核对填入的单号，再手动点击“查询”，找到匹配就联系对方核对包裹并安排交还。</li>
        <li>暂未匹配时，在待提交列表填写正确的微信号或电话，点击“确认挂失”或“全部提交”并等待登记成功提示。</li>
        <li>登记成功后保存回执和私密管理链接，以后从“<Link to="/local">本机记录</Link>”查看进展或用原单号再次查询。</li>
      </ol>
    </section>

    <section className="pdd-help-section pdd-help-important" aria-labelledby="pdd-help-important-title">
      <h2 id="pdd-help-important-title">必读提醒</h2>
      <ul className="pdd-help-reminders">
        <li><h3>必须填国内运输的快递单号</h3><p>请填写韵达、顺丰、极兔、圆通等国内运输的完整快递单号，方便后续追查；<strong>不要填写 JTTH 开头的集运单号，这类单号无法用于平台查找。</strong></p></li>
        <li><h3>不再追查，无需删除登记</h3><p>如果不需要追查了，不需要删除登记，因为没有人匹配到时，不会产生任何影响。</p></li>
        <li><h3>一定要填写正确的联系方式</h3><p>请核对微信号或电话，确保捡到快递或挂失快递的人能联系到你。</p></li>
        <li><h3>推荐给身边的人，帮不会使用的人登记</h3><p>请把平台推荐给还不知道的朋友，并协助不会使用的老人、孩子登记；平台传播得越广、登记的信息越多，找回的可能性就越大，也能尽量避免大家的损失。</p></li>
      </ul>
    </section>

    <section className="pdd-help-section">
      <h2>遇到这些情况时</h2>
      <div className="pdd-help-result"><h3>扫码没识别到</h3><p>将完整条形码和两端白边放入框内，点击“拍照识别”，看到“已拍照，正在识别”后等结果；未识别到可移远后重拍、点击“开启自动扫码”或改用手机。</p></div>
      <div className="pdd-help-result"><h3>单号有字符看不清</h3><p>用 <code>?</code> 或 <code>*</code> 代替一位，至少保留6位清楚的字母或数字，每个符号只代表一位；不完整单号先核对完整后再查询和登记。</p><p>不要填写订单编号或末端配送单号，复制完整号码时保留开头的0。</p></div>
      <div className="pdd-help-result"><h3>找到疑似包裹线索</h3><p><strong>请截图保存本页，联系 CMI 小助手获取进一步核实与对接。</strong></p><p>完整单号可点击“仍要登记这个完整单号”加入待提交列表；带 <code>?</code> 或 <code>*</code> 的单号须核对完整后再登记。</p></div>
      <div className="pdd-help-result"><h3>已经登记或查询失败</h3><p>已经登记的单号无需重复提交；查询失败时按页面提示重试，失败不等于没有匹配。</p></div>
    </section>

    <section className="pdd-help-section">
      <h2>背后的原理与隐私说明</h2>
      <div className="pdd-help-result"><h3>相同单号提供联系线索</h3><p>平台按完整国内快递单号匹配“丢件”和“错收件”登记，匹配后还需确认包裹归属。</p><p>疑似线索的字符相似度超过70%、低于100%，只比较单号文字，不代表包裹归属，也不显示对方联系方式或备注。</p></div>
      <div className="pdd-help-result"><h3>确认提交后才正式登记</h3><p>待提交列表只是当前浏览器中的暂存，页面确认登记成功后，才算正式保存。</p><p>填写的微信或电话及补充说明会展示给查询相同完整单号的另一方，用于联系与交还。</p></div>
      <div className="pdd-help-result"><h3>保护画面与管理链接</h3><p>相机画面和拍照图片只在本机识别，不会上传。</p><p>私密管理链接只留给自己；换设备或清理浏览器不会自动恢复凭证，请妥善保存。</p></div>
      <div className="pdd-help-result"><h3>主动查询，社区协助</h3><p>这是 CMI Community 的公益项目，不收取登记费用，也不会自动发送微信或短信；需要协助时，请查看首页底部的找货群和 CMI 小助手入口。</p></div>
      <Link to="/privacy" className="pdd-help-detail-link"><ShieldCheck size={18} aria-hidden="true" />查看隐私与使用说明<ArrowRight size={17} aria-hidden="true" /></Link>
    </section>

    <div className="pdd-help-ending"><p><Heart size={20} aria-hidden="true" />感谢每一条准确的登记，让包裹多一个回家的机会。</p><Link to="/" className="pdd-button pdd-primary pdd-full"><ScanLine size={19} aria-hidden="true" />返回首页，开始查询<ArrowRight size={18} aria-hidden="true" /></Link></div>
  </div>;
}

export default HelpPage;
