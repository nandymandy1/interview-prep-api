import bcrypt from 'bcryptjs';

export class PasswordService {
  private readonly rounds = 12;

  hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.rounds);
  }

  compare(password: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(password, passwordHash);
  }
}
