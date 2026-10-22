import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc, Model<UserDoc>>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);

export const User = model<UserDoc>('User', userSchema);
export type UserHydrated = HydratedDocument<UserDoc>;
