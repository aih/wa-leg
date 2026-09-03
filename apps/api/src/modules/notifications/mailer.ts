// Delivery adapters. SMTP in development (the mailpit sink), memory in tests; Microsoft Graph is the
// production adapter named in ARCHITECTURE.md and is not part of the POC.
import nodemailer, { type Transporter } from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly name: string;
  send(mail: Mail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  private readonly transport: Transporter;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  }
}

export class MemoryMailer implements Mailer {
  readonly name = 'memory';
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}

export class NullMailer implements Mailer {
  readonly name = 'none';
  async send(): Promise<void> {
    /* email disabled */
  }
}
