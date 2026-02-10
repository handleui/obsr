import { Avatar, AvatarFallback, AvatarImage } from "facehash";

interface UserAvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
}

const UserAvatar = ({ src, name, size = 32, className }: UserAvatarProps) => (
  <Avatar className={className}>
    {src && <AvatarImage alt={name} src={src} />}
    <AvatarFallback facehashProps={{ size }} name={name} />
  </Avatar>
);

export { UserAvatar };
export type { UserAvatarProps };
