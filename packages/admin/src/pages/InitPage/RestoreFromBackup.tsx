import { Alert, Button, Modal, Progress, Upload, message } from 'antd';
import { useState } from 'react';
import { useHistory } from 'umi';
import {
  INIT_RESTORE_ACCEPT,
  INIT_RESTORE_ENDPOINT,
  INIT_RESTORE_FILE_FIELD,
  INIT_RESTORE_LOGIN_PATH,
  INIT_RESTORE_TOKEN_KEY,
  classifyRestoreSuccess,
  describeFileSize,
  describeRestoreFailure,
  parseRestoreResponse,
} from './restoreCore';
import { SETUP_KEY_FIELD, SETUP_KEY_HINTS } from './setupKeyCore';

/**
 * init 页的「用整站备份恢复」卡片。
 *
 * 与后台「系统设置 → 备份与恢复 → 上传备份并恢复」（SystemConfig/tabs/Backup.jsx）
 * 同一套上传语义：multipart、文件字段名 `file`、同样的归档扩展名、成功回标准信封
 * `{statusCode:200,data}`。差别只有三点：
 * 1. 打到**免登录**的 init 端点（`/api/admin/init/restore`），不带 token 头；
 * 2. 需要真实的**上传进度**（几十 MB 的归档 + 1–2 分钟的服务端恢复，不能看起来像卡死）
 *    —— antd Upload 的内置上传器也能给 percent，但这里要在「用户确认之后」才开始传，
 *    所以用 beforeUpload 返回 false 拦下文件，确认后走裸 XHR（upload.onprogress）；
 * 3. 成功后**按 `data.initialized` 分支**（不是按 HTTP 200！）：
 *    - `initialized:true`：清掉本地旧 token（与 LogoutButton 的登出路径一致：
 *      removeItem('token')）并跳登录页 —— 凭据是**备份里的那一套**；
 *    - `initialized:false`（归档没有 users 集合时恢复照样 200 成功，站点仍是
 *      未初始化；老 server 不发这个字段也按 false 处理）：**留在 init 页**，
 *      向导照常可用，提示用户继续走向导创建管理员账号；不清不写任何 token、不跳转
 *      —— 否则会把用户扔到一个没有任何账号的登录页上。
 *
 * 初始化密钥（setup key）：服务端开 `VANBLOG_INIT_REQUIRE_SETUP_KEY=true` 时，
 * 这条路由也要求密钥（multipart 文本字段 `setupKey`）。密钥值由父组件（InitPage）
 * 统一管理 —— 与向导**共用同一个输入框与状态**：
 *  - props.setupKey 有值就随 FormData 一起发；
 *  - 服务端回 400 `setupKeyRequired:true` 时通过 props.onSetupKeyRequired 把
 *    原话交给父组件显示输入框，本组件的 Modal 里也原样展示 message + 指路提示。
 *
 * ⚠️ 不依赖初始化向导的任何字段：这张卡在 StepsForm 之外、渲染在它前面，
 * 用户一个输入框都不用碰（除非服务端真的要密钥）。
 */
type Phase = 'idle' | 'uploading' | 'restoring';

interface RestoreFromBackupProps {
  /** 初始化密钥（服务端要求时由 InitPage 的共享输入框提供；可空 = 不带该字段） */
  setupKey?: string;
  /** 服务端回"需要初始化密钥"的 400 时回调（message 是服务端原话，需原样展示） */
  onSetupKeyRequired?: (message: string) => void;
}

export default function RestoreFromBackup(props: RestoreFromBackupProps = {}) {
  const { setupKey, onSetupKeyRequired } = props;
  const history = useHistory();
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const busy = phase !== 'idle';

  const goLogin = () => {
    history.replace(INIT_RESTORE_LOGIN_PATH);
  };

  const startUpload = (file: File) => {
    setPhase('uploading');
    setPercent(0);
    const form = new FormData();
    form.append(INIT_RESTORE_FILE_FIELD, file);
    // 服务端要求初始化密钥时随包带上（multipart 文本字段；字段限额 8，远没到）
    const key = String(setupKey == null ? '' : setupKey).trim();
    if (key) {
      form.append(SETUP_KEY_FIELD, key);
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', INIT_RESTORE_ENDPOINT);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setPercent(Math.round((event.loaded / event.total) * 100));
      }
    };
    // 请求体发完 ≠ 恢复完成：服务端还要解压 + 导库 + 落静态文件（1–2 分钟量级），
    // 这段时间进度条停在 100%，用「正在恢复」的提示条告诉用户没卡死
    xhr.upload.onload = () => {
      setPercent(100);
      setPhase('restoring');
    };
    xhr.onload = () => {
      const result = parseRestoreResponse(xhr.status, xhr.responseText);
      setPhase('idle');
      setPercent(0);
      if (result.ok) {
        const info = classifyRestoreSuccess(result.data);
        // 细节区块：两种成功分支共用；每个字段都是可选的，服务端形状变了
        // 也只是少显示几行，不会崩
        const detail = (
          <>
            {info.seconds !== null && <p>耗时 {info.seconds} 秒。</p>}
            {info.countsText ? <p>恢复进来：{info.countsText}</p> : null}
            {info.databases &&
              Object.entries(info.databases).map(([dbName, item]) => (
                <p key={dbName}>
                  {dbName}：{(item as any)?.collections ?? 0} 张表 /{' '}
                  {(item as any)?.documents ?? 0} 条
                </p>
              ))}
            {info.static &&
              Object.entries(info.static).map(([folder, item]) => (
                <p key={folder}>
                  静态文件 {folder}：{(item as any)?.files ?? 0} 个
                </p>
              ))}
            {info.notes.length > 0 && (
              <ul style={{ paddingLeft: 20, color: '#888' }}>
                {info.notes.map((note) => (
                  // notes 是运维相关的原话（含「建议重启 server 进程」这类指示），原样展示
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </>
        );
        if (info.initialized) {
          // 旧 token 必然失效（jwt 密钥来自备份），按登出路径的写法清掉再进登录页
          window.localStorage.removeItem(INIT_RESTORE_TOKEN_KEY);
          Modal.success({
            title: '恢复完成',
            width: 560,
            okText: '去登录',
            onOk: goLogin,
            onCancel: goLogin,
            content: (
              <div>
                <p style={{ fontWeight: 600 }}>
                  请用<b>备份文件里的那套账号密码</b>登录 —— 不是这个页面上填过的任何内容。
                </p>
                {info.adminUserFromArchive ? null : (
                  <p style={{ color: '#fa8c16' }}>
                    注意：这份归档本身没有带用户记录。若备份里的账号登录不上，可用 server
                    日志里的恢复密钥走「忘记密码」流程。
                  </p>
                )}
                {detail}
              </div>
            ),
          });
          return;
        }
        // initialized:false（或老 server 没发这个字段）：数据已导入，但归档里没有
        // 管理员账号，站点仍算未初始化 —— **留在本页**，向导照常可用；
        // 不清不写任何 token、不跳转（跳去登录页会把用户扔进一个没有账号的站点）。
        Modal.success({
          title: '数据已恢复，但备份里没有管理员账号',
          width: 560,
          okText: '继续初始化',
          content: (
            <div>
              <p>
                归档里的数据已经导入本站，但它<b>不包含</b>管理员账号 ——
                站点仍处于未初始化状态。
              </p>
              <p>
                请继续用下面的初始化向导创建管理员账号；刚恢复进来的文章、图片、设置都会保留。
              </p>
              {detail}
            </div>
          ),
        });
        return;
      }
      // 服务端在要初始化密钥：把原话交给父组件（显示共享输入框），
      // 弹窗里也原样展示 message，并把「去哪找密钥」的提示放在最前面
      if (result.setupKeyRequired) {
        if (typeof onSetupKeyRequired === 'function') {
          onSetupKeyRequired(result.message);
        }
      }
      const hints = result.setupKeyRequired
        ? SETUP_KEY_HINTS.concat(describeRestoreFailure(xhr.status, result.message))
        : describeRestoreFailure(xhr.status, result.message);
      Modal.error({
        title: result.setupKeyRequired ? '需要初始化密钥' : '恢复失败',
        width: 560,
        content: (
          <div>
            {/* 服务端的原话永远原样展示（409 在跑 / 403 已初始化 / 429 限流 /
                400 校验失败/要密钥的原因都在里面），提示只作补充 */}
            <p>{result.message}</p>
            <ul style={{ paddingLeft: 20, color: '#888' }}>
              {hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          </div>
        ),
      });
    };
    xhr.onerror = () => {
      setPhase('idle');
      setPercent(0);
      message.error('上传失败：网络错误或服务不可达，请确认 server 正在运行后重试。');
    };
    xhr.onabort = () => {
      setPhase('idle');
      setPercent(0);
    };
    xhr.send(form);
  };

  return (
    <div>
      <Upload
        // 拦截自动上传：先弹确认（这一步会覆盖整个站点），确认后才开始传。
        // 确认不需要用户输入任何东西，只点一次「我确定，恢复」。
        beforeUpload={(file) => {
          if (busy) {
            return false;
          }
          Modal.confirm({
            title: `用 ${file.name}（${describeFileSize(file.size)}）恢复整个站点？`,
            width: 560,
            okText: '我确定，恢复',
            okButtonProps: { danger: true },
            cancelText: '取消',
            content: (
              <div>
                <p>将用这份整站备份覆盖并初始化本站：</p>
                <ul style={{ paddingLeft: 20 }}>
                  <li>数据库全部集合（文章、草稿、分类、标签、图床记录、设置、访问统计…）</li>
                  <li>waline 评论库</li>
                  <li>本地静态文件（图床图片与缩略图、附件、自定义页面）</li>
                </ul>
                <p style={{ color: '#888' }}>
                  管理员账号与密码<b>来自备份文件</b>，下面初始化向导里的任何输入都不需要。
                  备份带有管理员账号时，恢复完成后直接去登录页；万一这份归档里没有账号，
                  站点会保持未初始化，回来继续走向导建一个即可。
                </p>
              </div>
            ),
            onOk: () => {
              startUpload(file as unknown as File);
            },
          });
          return false;
        }}
        showUploadList={false}
        name={INIT_RESTORE_FILE_FIELD}
        accept={INIT_RESTORE_ACCEPT}
        disabled={busy}
      >
        <Button type="primary" loading={busy} disabled={busy}>
          {busy ? (phase === 'restoring' ? '正在恢复…' : '正在上传…') : '上传备份并恢复'}
        </Button>
      </Upload>
      {busy && (
        <div style={{ marginTop: 12, maxWidth: 480 }}>
          <Progress
            percent={percent}
            status={phase === 'restoring' ? 'active' : 'normal'}
          />
          {phase === 'restoring' && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 8 }}
              message="上传完成，服务端正在恢复（解压 + 导入数据库 + 写回静态文件）。几十 MB 的备份通常要 1–2 分钟，请不要关闭或刷新页面。"
            />
          )}
        </div>
      )}
    </div>
  );
}
