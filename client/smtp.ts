import type { ResolvedSendConfig } from "../config/mail/mod.ts";
import { ResolvedClientOptions } from '../config/client/mod.ts'
import { SMTPConnection } from "./connection.ts";

const CommandCode = {
  READY: 220,
  AUTHO_SUCCESS: 235,
  OK: 250,
  BEGIN_DATA: 354,
  FAIL: 554,
};


export class SmtpClient {
  #connection: SMTPConnection

  constructor(private config: ResolvedClientOptions) {
    const c = new SMTPConnection(config)
    this.#connection = c

    this.#ready = (async () => {
      await c.ready
      await this.prepareConnection()
    })()
  }

  #ready: Promise<void>

  async close() {
    await this.#connection.close()
  }

  get isSending() {
    return this.#currentlySending
  }

  get idle() {
    return this.#idlePromise
  }

  #idlePromise = Promise.resolve()
  #idleCB = () => {}

  // #encodeLB = false

  #currentlySending = false;
  #sending: (() => void)[] = [];

  #cueSending() {
    if (!this.#currentlySending) {
      this.#idlePromise = new Promise((res) => {
        this.#idleCB = res
      })
      this.#currentlySending = true;
      return;
    }

    return new Promise<void>((res) => {
      this.#sending.push(() => {
        this.#currentlySending = true;
        res();
      });
    });
  }

  #queNextSending() {
    if (this.#sending.length === 0) {
      this.#currentlySending = false;
      this.#idleCB()
      return;
    }

    const run = this.#sending[0];

    this.#sending.splice(0, 1);

    queueMicrotask(run);
  }

  async send(config: ResolvedSendConfig) {
    await this.#ready
    try {
      await this.#cueSending();

      await this.#connection.writeCmd("MAIL", "FROM:", `<${config.from.mail}>`);
      this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.OK);

      for (let i = 0; i < config.to.length; i++) {
        await this.#connection.writeCmd("RCPT", "TO:", `<${config.to[i].mail}>`);
        this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.OK);
      }

      for (let i = 0; i < config.cc.length; i++) {
        await this.#connection.writeCmd("RCPT", "TO:", `<${config.cc[i].mail}>`);
        this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.OK);
      }

      for (let i = 0; i < config.bcc.length; i++) {
        await this.#connection.writeCmd("RCPT", "TO:", `<${config.bcc[i].mail}>`);
        this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.OK);
      }

      await this.#connection.writeCmd("DATA");
      this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.BEGIN_DATA);

      await this.#connection.writeCmd("Subject: ", config.subject);
      await this.#connection.writeCmd("From: ", `${config.from.name} <${config.from.mail}>`);
      if(config.to.length > 0){
        await this.#connection.writeCmd("To: ", config.to.map((m) => `${m.name} <${m.mail}>`).join(";"));
      }
      if(config.cc.length > 0){
        await this.#connection.writeCmd("Cc: ", config.cc.map((m) => `${m.name} <${m.mail}>`).join(";"));
      }
      
      await this.#connection.writeCmd("Date: ", config.date);

      if (config.inReplyTo) {
        await this.#connection.writeCmd("InReplyTo: ", config.inReplyTo);
      }

      if (config.references) {
        await this.#connection.writeCmd("Refrences: ", config.references);
      }

      if (config.replyTo) {
        await this.#connection.writeCmd("ReplyTo: ", `${config.replyTo.name} <${config.replyTo.name}>`);
      }

      if (config.priority) {
        await this.#connection.writeCmd("Priority:", config.priority);
      }

      await this.#connection.writeCmd("MIME-Version: 1.0");

      await this.#connection.writeCmd(
        "Content-Type: multipart/mixed; boundary=attachment",
        "\r\n",
      );
      await this.#connection.writeCmd("--attachment");

      await this.#connection.writeCmd(
        "Content-Type: multipart/alternative; boundary=message",
        "\r\n",
      );

      for (let i = 0; i < config.mimeContent.length; i++) {
        await this.#connection.writeCmd("--message");
        await this.#connection.writeCmd(
          "Content-Type: " + config.mimeContent[i].mimeType,
        );
        if (config.mimeContent[i].transferEncoding) {
          await this.#connection.writeCmd(
            `Content-Transfer-Encoding: ${
              config.mimeContent[i].transferEncoding
            }` + "\r\n",
          );
        } else {
          // Send new line
          await this.#connection.writeCmd("");
        }

        await this.#connection.writeCmd(config.mimeContent[i].content, "\r\n");
      }

      await this.#connection.writeCmd("--message--\r\n");

      for (let i = 0; i < config.attachments.length; i++) {
        const attachment = config.attachments[i];

        await this.#connection.writeCmd("--attachment");
        await this.#connection.writeCmd(
          "Content-Type:",
          attachment.contentType + ";",
          "name=" + attachment.filename,
        );

        await this.#connection.writeCmd(
          "Content-Disposition: attachment; filename=" + attachment.filename,
          "\r\n",
        );

        if (attachment.encoding === "binary") {
          await this.#connection.writeCmd("Content-Transfer-Encoding: binary");

          if (
            attachment.content instanceof ArrayBuffer ||
            attachment.content instanceof SharedArrayBuffer
          ) {
            await this.#connection.writeCmdBinary(new Uint8Array(attachment.content));
          } else {
            await this.#connection.writeCmdBinary(attachment.content);
          }

          await this.#connection.writeCmd("\r\n");
        } else if (attachment.encoding === "text") {
          await this.#connection.writeCmd("Content-Transfer-Encoding: quoted-printable");

          await this.#connection.writeCmd(attachment.content, "\r\n");
        }
      }

      await this.#connection.writeCmd("--attachment--\r\n");

      await this.#connection.writeCmd(".\r\n");

      this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.OK);
    } catch (ex) {
      this.#queNextSending();
      throw ex;
    }
    await this.#cleanup()
    this.#queNextSending();
  }

  async prepareConnection() {
    this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.READY);

    await this.#connection.writeCmd("EHLO", this.config.connection.hostname);

    const cmd = await this.#connection.readCmd();
    
    if(!cmd) throw new Error("Unexpected empty response");
    
    if(typeof cmd.args === 'string') {
      this.#supportedFeatures.add(cmd.args)
    } else {
      cmd.args.forEach(cmd => {
        this.#supportedFeatures.add(cmd)
      })
    }

    if (this.#supportedFeatures.has('STARTTLS')) {
      await this.#connection.writeCmd("STARTTLS");
      this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.READY);

      const conn = await Deno.startTls(this.#connection.conn!, {
        hostname: this.config.connection.hostname,
      });
      this.#connection.setupConnection(conn)
      this.#connection.secure = true

      await this.#connection.writeCmd("EHLO", this.config.connection.hostname);

      await this.#connection.readCmd();
    }

    if (!this.config.debug.allowUnsecure && !this.#connection.secure) {
      throw new Error(
        "Connection is not secure! Don't send authentication over non secure connection!",
      );
    }

    if (this.config.connection.auth) {
      await this.#connection.writeCmd("AUTH", "LOGIN");
      this.#connection.assertCode(await this.#connection.readCmd(), 334);

      await this.#connection.writeCmd(btoa(this.config.connection.auth.username));
      this.#connection.assertCode(await this.#connection.readCmd(), 334);

      await this.#connection.writeCmd(btoa(this.config.connection.auth.password));
      this.#connection.assertCode(await this.#connection.readCmd(), CommandCode.AUTHO_SUCCESS);
    }

    await this.#cleanup()
  }

  #supportedFeatures = new Set<string>()

  async #cleanup() {
    this.#connection.writeCmd('NOOP')

    while (true) {
      const cmd = await this.#connection.readCmd()
      if(cmd && cmd.code === 250) return
    }
  }
}
