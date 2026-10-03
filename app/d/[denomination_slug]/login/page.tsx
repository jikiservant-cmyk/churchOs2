import { getDenominationBranding } from '@/lib/denomination';
import DenominationLoginForm from '@/components/DenominationLoginForm';

export default async function DenominationLoginPage({
  params,
}: {
  params: Promise<{ denomination_slug: string }>;
}) {
  const { denomination_slug } = await params;
  const slug = denomination_slug.toLowerCase().trim();
  const branding = await getDenominationBranding(slug);

  return <DenominationLoginForm slug={slug} branding={branding} />;
}
