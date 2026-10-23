// Compatibility export for existing application call sites. All SMS now enters
// church.sms_queue and is sent only by the church-najiki-dispatch Edge Function.
export { sendSingleSMS } from '@/lib/sms-dispatch';
