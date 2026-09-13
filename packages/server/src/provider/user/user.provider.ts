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

function pickPermissions(permission: unknown): string[] {
  if (!Array.isArray(permission)) {
    return [];
  }
  return permission.filter((p): p is string => typeof p === 'string').slice(0, 200);
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
  async washUserWithSalt() {
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
    }
  }

  async validateUser(name: string, password: string) {
    // encryptPassword() 在任一入参为空时返回 ''，而历史数据里可能存在空哈希
    // （旧版 updateUser / updateCollaborator 在 password 缺失时就会写入 ''），
    // 那样「空密码」会真的匹配上——等于账号无密码可登。这里两头都挡死。
    if (typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password) {
      return null;
    }
    const user = await this.userModel.findOne({ name });
    if (!user) {
      return null;
    } else {
      // 不再拿算出来的哈希去 Mongo 里查（那样只能支持一种格式），
      // 改成取出用户后在 JS 里校验：新格式 scrypt、旧格式 sha256 都认。
      if (!verifyUserPassword(user.password, name, password, user.salt)) {
        return null;
      }
      // 登录成功顺手轮换盐；旧格式的哈希会在这一刻被升级成 scrypt
      this.updateSalt(user, password);
      return user;
    }
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
    const salt = makeSalt();
    const encrypted = hashSecret(password);
    if (!encrypted) {
      throw new BadRequestException('密码不合法，未创建协作者');
    }
    // 只写白名单字段：旧实现 `{type:'collaborator', ...dto}` 里 dto 在后，
    // 客户端多带一个 `type: 'admin'` 或 `id` 就能把新协作者写成管理员 / 顶掉别人的 id。
    return await this.userModel.create({
      id: await this.getNewId(),
      type: 'collaborator',
      name,
      nickname: pickNickname(collaboratorDto?.nickname, name),
      permission: pickPermissions(collaboratorDto?.permission),
      password: encrypted,
      salt,
    });
  }
  async updateCollaborator(collaboratorDto: Collaborator) {
    const { name } = collaboratorDto;
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
    return await this.userModel.updateOne(
      {
        id: oldData.id,
        type: 'collaborator',
      },
      {
        // 同样只写白名单：不让请求体改 type / id / salt
        nickname: pickNickname(collaboratorDto?.nickname, oldData.name),
        permission: pickPermissions(collaboratorDto?.permission),
        password: encrypted,
        salt,
      },
    );
  }
  async deleteCollaborator(id: number) {
    await this.userModel.deleteOne({ id: id, type: 'collaborator' });
  }
}
