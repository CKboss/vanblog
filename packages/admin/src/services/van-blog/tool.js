import moment from 'moment';
import { formatTimeAgo } from './relativeTime';

export const randomKey = () => {
  return (Math.random() * 1000000).toFixed(0);
};
const formatStr = 'YYYY-MM-DD HH:mm:ss';
export const getTime = (str) => {
  if (!str) {
    return '-';
  }
  return moment(str).format(formatStr);
};
export const formatTimes = (...args) => {
  for (const each of args) {
    try {
      return moment(each).format(formatStr);
    } catch {}
  }
  return '-';
};
// 🔴 t 要**转发**给 formatTimeAgo（否则"N 秒前"永远中文）；尾参可选 ⇒ 老调用点行为不变
export const getRecentTimeDes = (timestr, now, t) => {
  return formatTimeAgo(timestr, now, t);
};
