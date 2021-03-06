import * as Discord from "discord.js"
import { sprintf } from "sprintf-js"
import { file } from "tmp-promise"
import Config from "../../config"
import Log from "../../log"
import Plugin from "../plugin"
import { MainCfg } from "../runtime"
import { ChainData, cloneMessage, CmdParam, CommandHelp,
  CommandStatus, DiscordFormat, ParamType, sendClonedMsg } from "../runutil"

const regexEmoji = /<:[A-Za-z0-9_]{2,}:\d+>/ig
export default class Gather extends Plugin {
    // declare config file: use save data
    protected config = new GatherConfig()
    // declare command.
    private gather:CommandHelp
    private remove:CommandHelp
    /**
     * Initialize command
     */
    public async ready() {
        // super: load config
        super.ready()
        // CommandHelp: suffix, description
        this.gather = new CommandHelp("집결", this.lang.gather.gatherDesc, true, {reqAdmin: true})
        this.gather.addField(ParamType.to, "대표", false)
        this.remove = new CommandHelp("집결 해제", this.lang.gather.removeDesc, true, {reqAdmin: true})
        // this.remove.addField(ParamType.to, "방ID", true);
        // get parameter as complex
        this.gather.complex = true
        return Promise.resolve()
    }
    public async onMessage(msg:Discord.Message) {
        if (msg.channel.type === "dm") {
            return Promise.resolve()
        }
        if (regexEmoji.test(msg.content)) {
            // const emojies
        }
        const cfg = await this.sub(this.config, msg.guild.id)
        if (!msg.guild.channels.has(cfg.destChannel)) {
            return Promise.resolve()
        }
        const destCh = msg.guild.channels.get(cfg.destChannel) as Discord.TextChannel
        const channel = msg.channel as Discord.TextChannel

        if (cfg.listenChannels.indexOf(msg.channel.id) < 0) {
            return Promise.resolve()
        }
        // change image
        const name = `${DiscordFormat.getNickname(msg.member)} (#${(msg.channel as Discord.TextChannel).name})`
        const webhook = await this.getWebhook(destCh, name, DiscordFormat.getAvatarImage(msg.author)).catch(Log.e)
        if (webhook == null) {
            Log.w("Gather", "skip - no webhook")
            return Promise.resolve()
        }
        const msg2 = DiscordFormat.normalizeMsg(msg, msg.guild, true)
        // cast to dest
        await sendClonedMsg(webhook, cloneMessage(msg2))
        return Promise.resolve()
    }
    /**
     * on Command Received.
     */
    public async onCommand(msg:Discord.Message, command:string, state:CmdParam):Promise<void> {
        // test command if match
        const testGather = this.gather.check(this.global, command, state)
        const testRemove = this.remove.check(this.global, command, state)
        if (msg.channel.type !== "dm" && (testGather.match || testRemove.match)) {
            const cfg = await this.sub(this.config,msg.guild.id)
            const channel = msg.channel as Discord.TextChannel
            if (testGather.match && testGather.has(ParamType.to) && testGather.get(ParamType.to) === "대표") {
                cfg.destChannel = channel.id
                const webhook = await this.getWebhook(channel).catch(Log.e)
                if (webhook != null) {
                    cfg.webhookID = webhook.id
                }
                await channel.send(this.lang.gather.gatherDesc)
            } else {
                const i = cfg.listenChannels.indexOf(channel.id)
                if (testGather.match && i < 0) {
                    cfg.listenChannels.push(channel.id)
                    await channel.send(this.lang.gather.addGather)
                } else if (testRemove.match && i >= 0) {
                    cfg.listenChannels.splice(i, 1)
                    await channel.send(this.lang.gather.removeGather)
                }
            }
            await cfg.export()
        }
        return Promise.resolve()
    }
}
class GatherConfig extends Config {
    public listenChannels = []
    public destChannel = "1234"
    public webhookID = "2345"
    public lastImage = "_"
    constructor() {
        super("gather")
    }
}
