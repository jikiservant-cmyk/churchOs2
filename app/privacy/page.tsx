import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy — churchOs',
  description: 'How churchOs collects, uses, and protects church and member data.',
};

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: '1. What we collect',
    body: [
      'Account data: the email address and password hash for each pastor or administrator account.',
      'Church profile: your church\u2019s name, slug, meeting days, branding, and settings such as the birthday-wishes toggle and attendance flag threshold.',
      'Member data (entered by your church): names, phone numbers, email addresses, gender, youth status, and birthdays. We deliberately store only the month and day of a birthday — never the year — so ages can never be exposed or sent.',
      'Attendance and engagement data: event check-ins, flagged-absence records and their status, and event records.',
      'Messaging data: the messages your church queues and sends, their delivery status, and the wallet transactions that pay for them (balances, debits, and top-ups).',
    ],
  },
  {
    heading: '2. Why we use it',
    body: [
      'To operate your church workspace: dashboards, member and visitor rolls, attendance monitoring and absence flags, birthday messages (only when your pastor switches the feature on), and the SMS messaging you send.',
      'To bill messaging correctly, keep audit logs, and detect abuse of the platform.',
      'We do not sell personal data, and we do not use your church\u2019s member data to advertise to anyone.',
    ],
  },
  {
    heading: '3. Who data is shared with',
    body: [
      'Messaging providers: when your church sends an SMS, the recipient\u2019s phone number and message body are passed to our messaging provider (currently Africa’s Talking) for delivery.',
      'Infrastructure: the Service runs on Supabase (database and authentication hosting).',
      'Law enforcement or regulators, only where the law requires it.',
      'No other third parties receive your church\u2019s data.',
    ],
  },
  {
    heading: '4. How it is protected',
    body: [
      'Data is stored in a multi-tenant database with row-level security so that each church can only reach its own data. Passwords are handled by the authentication provider and never stored in plain text; denomination invite codes are stored only as cryptographic hashes.',
      'Access by our team is restricted, logged, and limited to what is needed to run and support the Service.',
    ],
  },
  {
    heading: '5. Retention and deletion',
    body: [
      'Your church\u2019s data is kept while your workspace is active. If you want data removed, contact your churchOs administrator; a workspace deletion removes its member, attendance, and messaging data. Audit records required for billing and abuse prevention may be retained.',
      'Automated messages stop the moment a pastor switches the relevant automation off in Settings.',
    ],
  },
  {
    heading: '6. Your responsibilities',
    body: [
      'As the data controller for your congregation, your church decides what member information to store and must collect it lawfully — only keep details you need, and only message people who belong to your community.',
      'The messaging rules in our Terms & Conditions (no political, abusive, or otherwise prohibited content) are part of protecting your members too.',
    ],
  },
  {
    heading: '7. Your rights',
    body: [
      'You may ask your church leadership to correct or remove your personal details from their register at any time. Pastors may contact the churchOs team for help exporting or deleting a workspace\u2019s data.',
      'We handle requests in line with Uganda\u2019s Data Protection and Privacy Act, 2019 and aim to respond promptly.',
    ],
  },
  {
    heading: '8. Changes and contact',
    body: [
      'We may update this policy as the Service evolves; the date above always reflects the current version. Questions or requests go to the churchOs team through the support channels shared with your onboarding materials.',
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#E4D5BC] px-4 py-12" style={{ fontFamily: "'Outfit', sans-serif" }}>
      <div className="mx-auto max-w-3xl rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] p-8 shadow-sm sm:p-12">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[#B5622A]">churchOs</p>
        <h1 className="mb-2 text-3xl font-bold text-[#1E1208]" style={{ fontFamily: "'Playfair Display', serif" }}>
          Privacy Policy
        </h1>
        <p className="mb-8 text-sm text-[#9A7E65]">
          Last updated: 7 November 2026. Plain words about what we collect, why, and who sees it.
        </p>

        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <section key={section.heading}>
              <h2 className="mb-2 text-base font-bold text-[#1E1208]">{section.heading}</h2>
              <div className="space-y-3">
                {section.body.map((paragraph, index) => (
                  <p key={index} className="text-[13px] leading-relaxed text-[#4A3826]">
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-10 border-t border-[rgba(90,55,20,0.1)] pt-6 text-[13px] text-[#9A7E65]">
          See also our{' '}
          <Link href="/terms" className="font-bold text-[#B5622A] hover:underline">
            Terms &amp; Conditions
          </Link>
          .
        </div>
      </div>
    </main>
  );
}
