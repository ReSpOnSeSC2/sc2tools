import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <SignIn appearance={{ elements: { card: "bg-bg-surface" } }} />
    </div>
  );
}
