import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UpdateUserDto } from 'src/types/user.dto';
import { User, UserDocument } from 'src/scheme/user.schema';
import { Collaborator } from 'src/types/collaborator';
import { ALL_PERMISSION_VALUES } from 'src/types/access/access';
import { encryptPassword, hashSecret, makeSalt, verifyUserPassword, washPassword } from 'src/utils/crypto';

function assertCollaboratorName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value || value.length > 50) {
    throw new BadRequestException('协作者用户名不合法（1-50 个字符）');
  }
  return value;
}

function assertCollaboratorPassword(password: unknown): string {
  const value = typeof password === 'string' ? password : '';
  // 空密码会被 encryptPassword 变成空哈希，而空哈希曾经能用空密码登进来
  if (!value || value.length > 200) {
    throw new BadRequestException('协作者密码不合法（1-200 个字符）');
  }
  return value;
}

function pickNickname(nickname: unknown, fallback: string): string {
  return typeof nickname === 'string' && nickname.trim()
    ? nickname.trim().slice(0, 50)
    : fallback;
}

function pickPermissions(permission: unknown): { values: string[]; dropped: string[] } {
  if (!Array.isArray(permission)) {
    return { values: [], dropped: [] };
  }
  const values: string[] = [];
  const dropped: string[] = [];
  for (const raw of permission.slice(0, 200)) {
    if (typeof raw !== 'string') {
      dropped.push(String(raw));
      continue;
    }
    if ((ALL_PERMISSION_VALUES as readonly string[]).includes(raw)) {
      if (!values.includes(raw)) {
        values.push(raw);
      }
    } else {
      dropped.push(raw);
    }
  }
  return { values, dropped };
}

/**
 * 从 DTO 里取出权限数组。
 *
 * ⚠️ 两种拼写都要认：`types/collaborator.ts` 声明的是 `permission`（单数），
 * 而后台表单的字段名是 `permissions`（复数，`CollaboratorModal` 的 `name="permissions"`），
 * 所以请求体里实际到的是**复数**。旧实现只读单数 ⇒ 永远拿到 `undefined` ⇒ 存进去的是空数组，
 * 于是协作者一项权限都没有（详见 createCollaborator 上的说明）。
 */
function readPermissionsInput(collaboratorDto: any): unknown {
  if (Array.isArray(collaboratorDto?.permissions)) {
    return collaboratorDto.permissions;
  }
  return collaboratorDto?.permission;
}

@Injectable()
export class UserProvider {
  logger = new Logger(UserProvider.name);
  constructor(@InjectModel('User') private userModel: Model<UserDocument>) {}
  async getUser(isList?: boolean) {
    if (isList) {
      return await this.userModel.findOne({ id: 0 }, { id: 1, name: 1, nickname: 1 });
    }
    return await this.userModel.findOne({ id: 0 }).exec();
  }
  /** @returns 洗了多少个未加盐的老账号（供迁移台账记 detail） */
  async washUserWithSalt(): Promise<{ washed: number }> {
    // 如果没加盐的老版本，给改成带加盐的。
    // 注意这里**只能**继续用旧的 sha256 方案：输入是「上一代服务端哈希」，
    // 拿不到浏览器端派生值，没法直接换成 scrypt。等用户下次登录成功时，
    // updateSalt() 会自动把它升级成 scrypt。
    const users = await this.userModel.find({
      $or: [
        {
          salt: '',
        },
        {
          salt: { $exists: false },
        },
      ],
    });
    if (users && users.length > 0) {
      this.logger.log(`老版本清洗密码未加盐用户 ${users.length} 人`);
      for (const user of users) {
        const salt = makeSalt();
        const newPassword = washPassword(user.name, user.password, salt);
        await this.userModel.updateOne({ id: user.id }, { password: newPassword, salt });
      }
      return { washed: users.length };
    }
    return { washed: 0 };
  }

  async validateUser(name: string, password: string) {
    // encryptPassword() 在任一入参为空时返回 ''，而历史数据里可能存在空哈希
    // （旧版 updateUser / updateCollaborator 在 password 缺失时就会写入 ''），
    // 那样「空密码」会真的匹配上——等于账号无密码可登。这里两头都挡死。
    if (typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password) {
      return null;
    }
    // ⚠️ 以前是 `findOne({ name })`：既没有 type 过滤也没有排序，所以**同名时返回哪条不确定**
    //    （取决于自然顺序，重建索引或迁移之后可能就变了）。而 `createCollaborator` 过去只按
    //    `{name, type:'collaborator'}` 查重 ⇒ 完全可以建出一个与管理员同名的协作者。
    //    两者叠加的后果：同一个用户名的登录会落到不确定的账号上（自锁，或者拿协作者的口令
    //    登进管理员账号）。现在：①排序保证确定性（`id` 升序 ⇒ 管理员 id:0 永远排在最前）；
    //    ②真的查出重名就大声 WARN，因为那是需要人工修的数据问题，不该静默选一个。
    //    ③创建/改名两侧都禁止与管理员重名（见 createCollaborator / updateUser）。
    const candidates = await this.userModel.find({ name }).sort({ id: 1 }).limit(2).exec();
    const user = candidates[0];
    if (!user) {
      return null;
    }
    if (candidates.length > 1) {
      this.logger.error(
        `用户名「${name}」在 users 集合里有多条（id=${candidates
          .map((c) => c.id)
          .join(', ')}）：登录会固定命中 id 最小的那条（管理员 id:0 优先）。` +
          `请删掉重名的协作者或给管理员改名 —— 新建协作者时已经禁止与管理员同名。`,
      );
    }
    // 不再拿算出来的哈希去 Mongo 里查（那样只能支持一种格式），
    // 改成取出用户后在 JS 里校验：新格式 scrypt、旧格式 sha256 都认。
    if (!verifyUserPassword(user.password, name, password, user.salt)) {
      return null;
    }
    // 登录成功顺手轮换盐；旧格式的哈希会在这一刻被升级成 scrypt
    this.updateSalt(user, password);
    return user;
  }


  async updateSalt(user: User, passwordInput: string) {
    const newSalt = makeSalt();
    const hashed = hashSecret(passwordInput);
    if (!hashed) {
      // 绝不把空哈希写进库（空哈希曾经等于「空密码可登录」）
      return;
    }
    await this.userModel.updateOne(
      { id: user.id },
      {
        // salt 仍然轮换：旧格式校验要用它，新格式自带盐，留着不影响
        salt: newSalt,
        password: hashed,
      },
    );
  }

  async updateUser(updateUserDto: UpdateUserDto) {
    const currUser = await this.getUser();

    if (!currUser) {
      throw new NotFoundException();
    }
    // 旧实现是 `{...updateUserDto, password: encryptPassword(name, password, salt)}`，两个问题：
    // 1) name / password 缺失时 encryptPassword 返回空串，密码哈希被写成 ''，
    //    之后**任何密码都登不进来**（「忘记密码」自救通道尤其容易踩）；
    // 2) 把整个 DTO 展开进 Mongo 更新文档，请求体里多带的字段（id、甚至 $set）会被原样写库。
    const name = typeof updateUserDto?.name === 'string' ? updateUserDto.name.trim() : '';
    const password = typeof updateUserDto?.password === 'string' ? updateUserDto.password : '';
    if (!name || name.length > 50) {
      throw new BadRequestException('用户名不合法（1-50 个字符）');
    }
    if (!password || password.length > 200) {
      throw new BadRequestException('密码不合法（1-200 个字符）');
    }
    const nextPassword = hashSecret(password);
    if (!nextPassword) {
      // 理论上到不了这里（上面已经挡掉空值），留一道兜底：绝不把空哈希写进库
      throw new BadRequestException('密码不合法，未做任何修改');
    }
    // ⚠️ 不许把管理员改成与某个协作者同名：`validateUser` 是按 name 找账号的，
    //    同名会让"这个用户名登录进哪个账号"变得不确定（现在虽然有 `sort({id:1})` 保证
    //    确定性、且管理员 id:0 优先，但那只是兜底 —— 真正的修法是根本不允许重名）。
    //    与恢复流程叠加时尤其危险：`POST /api/admin/auth/restore` 会把表单里的 name
    //    写回管理员账号，等于持恢复密钥者可以顺手造出一个重名局面。
    const nameClash = await this.userModel.findOne({ name, type: 'collaborator' }).exec();
    if (nameClash) {
      throw new BadRequestException(
        `用户名「${name}」已被一个协作者占用，请换一个（管理员与协作者不能同名，否则登录会落到不确定的账号上）`,
      );
    }
    const update: Record<string, unknown> = { name, password: nextPassword };
    if (typeof updateUserDto.nickname === 'string') {
      update.nickname = updateUserDto.nickname.slice(0, 50);
    }
    return this.userModel.updateOne({ id: currUser.id }, update).exec();
  }
  async getNewId() {
    const [lastUser] = await this.userModel.find({}).sort({ id: -1 }).limit(1);
    if (!lastUser) {
      return 1;
    } else {
      return lastUser.id + 1;
    }
  }
  async getCollaboratorByName(name: string) {
    return await this.userModel.findOne({ name: name, type: 'collaborator' });
  }
  async getCollaboratorById(id: number) {
    return await this.userModel.findOne({ id, type: 'collaborator' });
  }
  async getAllCollaborators(isList?: boolean) {
    if (isList) {
      return await this.userModel.find(
        { type: 'collaborator' },
        { id: 1, name: 1, nickname: 1, _id: 0 },
      );
    }
    return await this.userModel.find({ type: 'collaborator' }, { salt: 0, password: 0, _id: 0 });
  }

  async createCollaborator(collaboratorDto: Collaborator) {
    const name = assertCollaboratorName(collaboratorDto?.name);
    const password = assertCollaboratorPassword(collaboratorDto?.password);
    const oldData = await this.getCollaboratorByName(name);
    if (oldData) {
      throw new ForbiddenException('已有为该用户名的协作者，不可重复创建！');
    }
    // ⚠️ 不许与管理员同名（旧实现只查了 `{name, type:'collaborator'}`，所以这条路是开的）。
    //    同名会让 `validateUser(name, …)` 落到不确定的账号上 —— 见 validateUser 里的说明。
    const admin = await this.getUser();
    if (admin && admin.name === name) {
      throw new ForbiddenException(
        `用户名「${name}」与管理员账号相同，不可用于协作者（否则该用户名登录会落到不确定的账号上）`,
      );
    }
    const salt = makeSalt();
    const encrypted = hashSecret(password);
    if (!encrypted) {
      throw new BadRequestException('密码不合法，未创建协作者');
    }
    const { values: permissions, dropped } = pickPermissions(readPermissionsInput(collaboratorDto));
    this.logDroppedPermissions('创建协作者', name, dropped);
    // 只写白名单字段：旧实现 `{type:'collaborator', ...dto}` 里 dto 在后，
    // 客户端多带一个 `type: 'admin'` 或 `id` 就能把新协作者写成管理员 / 顶掉别人的 id。
    return await this.userModel.create({
      id: await this.getNewId(),
      type: 'collaborator',
      name,
      nickname: pickNickname(collaboratorDto?.nickname, name),
      // ⚠️ 字段名必须是 **permissions**（复数）：`scheme/user.schema.ts` 声明的是
      //    `permissions?: Permission[]`，而旧实现写的是 `permission`（单数）——
      //    不在 schema 里的路径会被 mongoose 的 strict 模式**静默丢弃**。
      //    配合上面"只读单数 DTO 字段"的问题，协作者权限在过去是**两头都断**的：
      //    读不到（UI 发的是复数）⇒ 存空数组，而且就算读到了也存不进去（字段名不对）⇒
      //    `jwt.strategy` 读的 `user.permissions` 永远 undefined ⇒
      //    `AccessGuard` 对协作者一律拒绝（`permissions.length == 0`）。
      //    也就是说"协作者权限"这个功能此前根本没生效过；这次连同字段名一起修好。
      permissions,
      password: encrypted,
      salt,
    });
  }

  /** 丢弃未知权限值时留一条线索（不 400，理由见 pickPermissions）。 */
  private logDroppedPermissions(action: string, name: string, dropped: string[]) {
    if (!dropped.length) {
      return;
    }
    this.logger.warn(
      `${action}「${name}」时收到 ${dropped.length} 个未知权限值，已丢弃：${JSON.stringify(
        dropped.slice(0, 20),
      )}。合法取值见 types/access/access.ts 的 ALL_PERMISSION_VALUES。`,
    );
  }
  async updateCollaborator(collaboratorDto: Collaborator) {
    // ⚠️ 以前是 `const { name } = collaboratorDto;` 直接拿去查：name 缺失时
    //    `findOne({ name: undefined, type:'collaborator' })` 会被 mongoose 丢掉 undefined 条件
    //    ⇒ 退化成"随便找一个协作者"，于是"不带用户名的更新请求"会改掉**任意**一个协作者的口令。
    //    现在走同一个校验函数，缺失/非法一律 400。
    const name = assertCollaboratorName(collaboratorDto?.name);
    const oldData = await this.getCollaboratorByName(name);
    if (!oldData) {
      throw new ForbiddenException('没有此协作者！无法更新！');
    }
    const password = assertCollaboratorPassword(collaboratorDto?.password);
    const salt = makeSalt();
    const encrypted = hashSecret(password);
    if (!encrypted) {
      throw new BadRequestException('密码不合法，未修改协作者');
    }
    const { values: permissions, dropped } = pickPermissions(readPermissionsInput(collaboratorDto));
    this.logDroppedPermissions('更新协作者', name, dropped);
    return await this.userModel.updateOne(
      {
        id: oldData.id,
        type: 'collaborator',
      },
      {
        // 同样只写白名单：不让请求体改 type / id / salt
        nickname: pickNickname(collaboratorDto?.nickname, oldData.name),
        // ⚠️ 复数 `permissions`：见 createCollaborator 里的说明（写单数会被 strict 模式丢弃）
        permissions,
        password: encrypted,
        salt,
      },
    );
  }
  async deleteCollaborator(id: number) {
    await this.userModel.deleteOne({ id: id, type: 'collaborator' });
  }
}
