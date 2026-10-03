import { redirect } from 'next/navigation';

export default async function DenominationsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  const { slug } = await searchParams;
  if (slug) {
    redirect(`/d/${slug.toLowerCase().trim()}`);
  }
  redirect('/denominations');
}
