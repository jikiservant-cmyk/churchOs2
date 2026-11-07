import Link from 'next/link';

export const metadata = {
  title: 'Terms & Conditions — churchOs',
  description: 'The rules for using churchOs, including the messaging content policy every pastor agrees to at signup.',
};

const SECTIONS: { heading: string; body: string[] }[] = [
  {
    heading: '1. About these terms',
    body: [
      'These Terms & Conditions ("Terms") govern your use of churchOs — the church management application provided to churches, ministries, and their leadership ("the Service"). By creating an account you agree to these Terms on behalf of the church or organisation you represent, and you confirm you are authorised to do so.',
      'If you do not agree with these Terms, do not create an account or use the Service.',
    ],
  },
  {
    heading: '2. Your account',
    body: [
      'An account on churchOs is intended for the pastor or an authorised administrator of a church workspace. You are responsible for keeping your credentials secure and for all activity that happens under your account.',
      'You must provide accurate information when creating your workspace, and you may not create accounts for churches you are not authorised to represent.',
    ],
  },
  {
    heading: '3. Messaging rules — prohibited content',
    body: [
      'churchOs lets your church send SMS messages to its own members, visitors, and new converts. That privilege comes with strict rules. By using the Service you agree that you will NOT send, or allow to be sent, any of the following:',
      'Political messages — no political campaigning, electioneering, mobilisation for political parties, candidates, or referenda, or any message intended to influence political opinion.',
      'Abusive messages — no harassment, threats, intimidation, insults, bullying, hate speech, or content that discriminates on the basis of tribe, ethnicity, religion, gender, disability, or any other status.',
      'Illegal content — nothing that violates the laws of Uganda or any other applicable law, including fraud, scams, phishing, or incitement to violence.',
      'Sexual or obscene content — no pornographic or sexually explicit material.',
      'Spam and deception — no unsolicited bulk marketing, misleading sender identities, impersonation of another person or organisation, or false emergency claims.',
      'Messages must be sent only to people who belong to your church community or who have given you their contact details. Sending messages to purchased or harvested phone lists is forbidden.',
    ],
  },
  {
    heading: '4. Enforcement',
    body: [
      'We may investigate suspected violations of these Terms. Where a workspace is found to be sending prohibited content, we may warn its pastor, suspend its messaging, suspend the workspace, or terminate the account — with or without prior notice where the violation is serious or repeated.',
      'You remain solely responsible for the content of the messages your church sends through churchOs and for any claims or penalties arising from them.',
    ],
  },
  {
    heading: '5. Church data',
    body: [
      'You keep ownership of the data your church enters into churchOs. You are responsible for collecting your members\u2019 contact details lawfully and for only storing information you have a reason to keep. See the Privacy Policy for how we handle that data.',
    ],
  },
  {
    heading: '6. Service availability and billing',
    body: [
      'We work to keep the Service available, but we do not promise uninterrupted operation. SMS delivery depends on mobile network operators and is charged against your workspace wallet; message charges are set by the messaging provider and are not refunded for messages the network accepts and fails to deliver.',
    ],
  },
  {
    heading: '7. Changes to these terms',
    body: [
      'We may update these Terms from time to time. Material changes will be announced in the app or by email. Continuing to use the Service after a change means you accept the updated Terms.',
    ],
  },
  {
    heading: '8. Contact',
    body: ['Questions about these Terms can be sent to the churchOs team through the support channels shared with your onboarding materials.'],
  },
];

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#E4D5BC] px-4 py-12" style={{ fontFamily: "'Outfit', sans-serif" }}>
      <div className="mx-auto max-w-3xl rounded-2xl border border-[rgba(90,55,20,0.13)] bg-[#F0E6D3] p-8 shadow-sm sm:p-12">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[#B5622A]">churchOs</p>
        <h1 className="mb-2 text-3xl font-bold text-[#1E1208]" style={{ fontFamily: "'Playfair Display', serif" }}>
          Terms &amp; Conditions
        </h1>
        <p className="mb-8 text-sm text-[#9A7E65]">
          Last updated: 7 November 2026. Every pastor must accept these Terms, including the messaging
          content rules in section 3, before creating a workspace.
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
          <Link href="/privacy" className="font-bold text-[#B5622A] hover:underline">
            Privacy Policy
          </Link>
          .
        </div>
      </div>
    </main>
  );
}
