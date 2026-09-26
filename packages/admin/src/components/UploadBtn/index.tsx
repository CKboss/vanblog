import { Button, message, Upload } from 'antd';
import { useIntl } from 'umi';
import ImgCrop from 'antd-img-crop';
import { RcFile } from 'antd/lib/upload';

const toPosix = (p: string) => (p || '').replace(/\\/g, '/');

export default function (props: {
  setLoading: (loading: boolean) => void;
  text: string;
  onFinish: Function;
  url: string;
  accept: string;
  muti: boolean;
  crop?: boolean;
  folder?: boolean;
  customUpload?: boolean;
  basePath?: string | undefined;
  loading?: boolean;
  plainText?: boolean;
}) {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook）。这里弹的是 `message.*` —— 它渲染进
  //    **脱离 React 树的独立根**（§7.151 那条实测缺陷）⇒ 传进去的必须是**这里算好的字符串**，
  //    不能塞一个自己调 useIntl 的组件进去。
  const intl = useIntl();
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const upload = (file: RcFile, rPath: string) => {
    const formData = new FormData();
    let fileName = toPosix(rPath || file.name);
    if (!props.folder && props.basePath) {
      fileName = `${toPosix(props.basePath)}/${file.name}`.replace(/\/+/g, '/');
    }
    // Basename only in multipart: some browsers strip path separators from the filename param.
    formData.append('file', file, file.name);
    props.setLoading(true);
    const sep = props.url.includes('?') ? '&' : '?';
    fetch(`${props.url}${sep}name=${encodeURIComponent(fileName)}`, {
      method: 'POST',
      body: formData,
      headers: {
        token: (() => {
          return window.localStorage.getItem('token') || 'null';
        })(),
      },
    })
      .then((res) => res.json())
      .then((body) => {
        if (body?.statusCode && body.statusCode !== 200) {
          throw new Error(body.message || 'upload failed');
        }
        props?.onFinish(file, fileName);
      })
      .catch(() => {
        message.error(t('common.uploadFailedWithName', '{name} 上传失败!', { name: fileName }));
      })
      .finally(() => {
        props.setLoading(false);
      });
  };
  const Core = (
    <Upload
      showUploadList={false}
      // name="file"
      multiple={props.muti}
      accept={props.accept}
      action={props.url}
      directory={props.folder}
      beforeUpload={
        props.customUpload
          ? (file) => {
              let rPath = toPosix(file.webkitRelativePath);
              if (rPath && rPath.split('/').length >= 2) {
                rPath = rPath.split('/').slice(1).join('/');
              }
              upload(file, rPath);
              return false;
            }
          : undefined
      }
      headers={{
        token: (() => {
          return window.localStorage.getItem('token') || 'null';
        })(),
      }}
      onChange={(info) => {
        props?.setLoading(true);
        if (info.file.status !== 'uploading') {
          // console.log(info.file, info.fileList);
        }
        if (info.file.status === 'done') {
          props?.setLoading(false);
          props?.onFinish(info.file);
        } else if (info.file.status === 'error') {
          message.error(t('common.uploadFailedWithName', '{name} 上传失败!', { name: info.file.name }));
          props?.setLoading(false);
        }
      }}
    >
      {props.plainText ? (
        props.text
      ) : (
        <Button type="primary" loading={props.loading}>
          {props.text}
        </Button>
      )}
    </Upload>
  );
  if (props.crop) {
    return (
      <ImgCrop quality={1} fillColor="rgba(255,255,255,0)">
        {Core}
      </ImgCrop>
    );
  } else {
    return Core;
  }
}
