import * as Discord from "discord.js";
import { EventEmitter } from "events";
import { sprintf } from "sprintf-js";
import Config from "../config";
import Log from "../log";
import Ncc from "../ncc/ncc";
import Lang from "./lang";
import ArtiNoti from "./module/artinoti";
import Auth from "./module/auth";
import Cast from "./module/cast";
import Gather from "./module/gather";
import Login from "./module/login";
import Ping from "./module/ping";
import Plugin from "./plugin";
import { CommandHelp, CommandStatus, DiscordFormat, Keyword, ParamType } from "./runutil";

const queryCmd = /\s+\S+/ig;
const safeCmd = /(".+?")|('.+?')/i;
const presetCfgs:{[key:string]: string[]} = {
    "네이버 카페" : ["auth<%g>.commentURL", "artialert<%g>.cafeURL", "cast<%g>.cafeURL"],
    "프록시 채널" : ["auth<%g>.proxyChannel"],
    "인증 그룹" : ["auth<%g>.destRole"],
}

export default class Runtime extends EventEmitter {
    private global:MainCfg;
    private lang:Lang;
    private client:Discord.Client;
    private ncc:Ncc;
    private plugins:Plugin[] = [];
    private lastSaved:number;
    constructor() {
        super();
        // ,new Auth(), new Login()
        this.plugins.push(
            new Ping(), new Login(), new Auth(), new ArtiNoti(), new Cast(), new Gather());
    }
    public async start():Promise<string> {
        // load config
        this.global = new MainCfg();
        await this.global.import(true).catch((err) => null);
        // init client
        this.client = new Discord.Client();
        // create ncc - not authed
        this.ncc = new Ncc();
        // init lang
        this.lang = new Lang();
        // save time: now
        this.lastSaved = Date.now();
        // ncc test auth by cookie
        try {
            if (await this.ncc.loadCredit() != null) {
                Log.i("Runtime-ncc","login!");
            } else {
                Log.i("Runtime-ncc", "Cookie invalid :(");
            }
        } catch (err) {
            Log.e(err);
        }
        // event register
        this.plugins.forEach(((v,i) => {
            this.on("ready",v.ready.bind(v));
            this.on("message",v.onMessage.bind(v));
            this.on("save",v.onSave.bind(v));
        }));
        // client register
        this.client.on("ready",this.ready.bind(this));
        this.client.on("message",this.onMessage.bind(this));
        // ncc login

        // client login (ignore)
        this.client.login(this.global.token)
        return Promise.resolve("");
    }
    public async destroy() {
        this.client.removeAllListeners();
        try {
            await this.client.destroy();
            for (const plugin of this.plugins) {
                await plugin.onDestroy();
            }
            this.ncc.chat.disconnect();
        } catch (err) {
            Log.e(err);
            process.exit(-1);
        }
        // may save failed.
        // this.emit("save");
        return Promise.resolve();
    }
    protected async ready() {
        // init plugins
        for (const plugin of this.plugins) {
            plugin.init(this.client, this.ncc, this.lang,this.global);
        }
        this.emit("ready");
    }
    protected async onMessage(msg:Discord.Message) {
        const text = msg.content;
        const prefix = this.global.prefix;
        // onMessage should invoke everytime.
        this.emit("message",msg);
        // await Promise.all(this.plugins.map((value) => value.onMessage.bind(value)(msg)));
        // chain check
        if (msg.author.id === this.client.user.id) {
            // Self say.
            return Promise.resolve();
        }
        for (const plugin of this.plugins) {
            if (await plugin.callChain(msg,msg.channel.id, msg.author.id)) {
                // invoked chain.
                return Promise.resolve();
            }
        }
        // command check
        if (!prefix.test(text)) {
            // save configs 10 minutes inverval when normal...
            if (Date.now() - this.lastSaved >= 600000) {
                this.lastSaved = Date.now();
                this.emit("save");
            }
            return Promise.resolve();
        }
        let chain = msg.content;
        // zero, remove \" or \'..
        chain = chain.replace(/\\('|")/igm,"");
        chain = chain.replace(prefix,"");
        // first, replace "" or '' to easy
        const safeList:string[] = [];
        while (safeCmd.test(chain)) {
            const value = chain.match(safeCmd)[0];
            safeList.push(value.substring(value.indexOf("\"") + 1, value.lastIndexOf("\"")));
            chain = chain.replace(safeCmd,"${" + (safeList.length - 1) + "}");
        }
        // second, chain..
        let pieces:Keyword[] = [];
        let cacheWord:string[] = [];
        for (const piece of chain.match(queryCmd)) {
            const split = Object.entries(ParamType)
            .map((value) => [value[0],value[1].split("/")] as [string,string[]]).map((value) => {
                let check:Keyword = null;
                const [_typeN, _suffix] = value;
                for (const _value of _suffix) {
                    if (piece.endsWith(_value)) {
                        // match suffix
                        check = {
                            type: ParamType[_typeN],
                            str: piece.substring(0,piece.lastIndexOf(_value)),
                        };
                        break;
                    }
                }
                return check;
            }).filter((value) => value != null);
            let part;
            // select correct data
            if (split.length >= 1) {
                part = split[0].str;
            } else {
                part = piece;
            }
            safeList.forEach((value, index) => {
                part = part.replace(new RegExp("\\$\\{" + index + "\\}", "i"), value);
            });
            cacheWord.push(part);
            if (split.length >= 1) {
                // commit
                const key = {
                    type: split[0].type,
                    str: cacheWord.join("").trim(),
                    query: cacheWord
                } as Keyword;
                pieces.push(key);
                cacheWord = [];
            }
        }
        const _cmds = pieces.reverse().filter((v) => v.type === ParamType.do);
        // cmd exists?
        let cmd:string = null;
        if (_cmds.length >= 1) {
            cmd = _cmds[0].str;
            pieces = pieces.reverse().filter((v) => v.type !== ParamType.do).reverse();
        } else {
            // no exists :(
            cmd = cacheWord.join("").trim();
        }
        /*
          * hard coding!
        */
        try {
            if (await this.hardCodingCmd(msg, cmd, pieces)) {
                return;
            }
        } catch (err) {
            Log.e(err);
            return;
        }
        try {
            await Promise.all(this.plugins.map((value) => value.onCommand.bind(value)(msg, cmd, pieces)));
        } catch  (err) {
            Log.e(err);
        }
    }
    private async hardCodingCmd(msg:Discord.Message, cmd:string, pieces:Keyword[]):Promise<boolean> {
        let result = false;
        const helpCmd = new CommandHelp("도움,도와,도움말",this.lang.helpDesc,true);
        helpCmd.addField(ParamType.dest, "알고 싶은 명령어",false);
        const setCmd = new CommandHelp("설정,보여",this.lang.sudoNeed, false, { reqAdmin:true });
        setCmd.addField(ParamType.dest, "목적", true);
        setCmd.addField(ParamType.to, "설정값", false);
        const adminCmd = new CommandHelp("token", "토큰 인증", false, { dmOnly:true });
        adminCmd.addField(ParamType.to, "토큰 앞 5자리", true);
        const saveCmd = new CommandHelp("저장", "저장", true,{reqAdmin:true});

        const paramPair = helpCmd.check(msg.channel.type,this.global.isAdmin(msg.author.id));
        /*
            Help Command
        */
        const _help = helpCmd.test(cmd,pieces);
        if (!result && _help.match) {
            let dest = "*";
            if (_help.exist(ParamType.dest)) {
                dest = _help.get(ParamType.dest);
                if (dest.endsWith("명령어")) {
                    dest = dest.substring(0,dest.lastIndexOf("명령어") - 1).trim();
                }
                if (dest.length < 1) {
                    dest = "*";
                }
            }
            if (dest != null) {
                let helps:CommandHelp[] = [];
                if (dest === "*") {
                    /**
                     * Add hard-coded commands
                     */
                    helps.push(helpCmd, setCmd, adminCmd);
                }
                this.plugins.map((_v) => _v.help).forEach((_v,_i) => {
                    _v.forEach((__v,__i) => {
                        if (dest !== "*") {
                            if (__v.cmds.indexOf(dest) >= 0) {
                                helps.push(__v);
                            }
                        } else {
                            helps.push(__v);
                        }
                    });
                });
                // filter permission
                helps = helps.filter((_v) => {
                    return !((_v.dmOnly && msg.channel.type !== "dm") 
                    || (_v.reqAdmin && !this.global.isAdmin(msg.author.id)));
                });
                if (helps.length === 0) {
                    await msg.channel.send(sprintf(this.lang.helpNoExists,{help:dest}));
                } else {
                    for (let i = 0; i < Math.ceil(helps.length / 20); i += 1) {
                        const richMsg = new Discord.RichEmbed();
                        richMsg.setTitle(this.lang.helpTitle);
                        richMsg.setAuthor(getNickname(msg), msg.author.avatarURL);
                        for (let k = 0; k < Math.min(helps.length - 20 * i, 20); k += 1) {
                            richMsg.addField(helps[i * 20 + k].title, helps[i * 20 + k].description);
                        }
                        await msg.channel.send(richMsg);
                    }
                    result = true;
                }
            }
        }
        /**
         * Config command
         */
        const _set = setCmd.test(cmd, pieces, paramPair);
        if (!result && /* msg.channel.type === "dm" && */ _set.match) {
            /**
             * option set
             */
            if (!_set.has(ParamType.to)) {
                if (cmd.endsWith("보여")) {
                    _set.options.set(ParamType.to,"1");
                } else {
                    return Promise.resolve(false);
                }
            }
            /**
             * Extremely Dangerous Setting 
             */
            if (msg.channel.type === "dm" && !cmd.endsWith("보여")) {
                let pass = true;
                let reboot = false;
                switch (_set.get(ParamType.dest)) {
                    case "토큰" : {
                        // CAUTION
                        this.global.token = _set.get(ParamType.to);
                        reboot = true;
                    } break;
                    case "말머리" : {
                        this.global.prefix = new RegExp(_set.get(ParamType.to),"i");
                    } break;
                    default: {
                        pass = false;
                    }
                }
                if (pass) {
                    result = true;
                }
                if (reboot) {
                    await this.global.export().catch(Log.e);
                    await msg.channel.send(_set.get(ParamType.dest) + " 설정 완료. 재로드합니다.");
                    this.emit("restart");
                    return Promise.resolve(true);
                }
            }
            const richE:Discord.RichEmbed[] = [];
            const from = _set.get(ParamType.dest);
            const to = _set.get(ParamType.to);
            if (from === "프리셋" && cmd.endsWith("보여")) {
                const rich = new Discord.RichEmbed();
                for (const [presetK, presetFrom] of Object.entries(presetCfgs)) {
                    rich.addField(presetK, presetFrom.join("\n").replace(/%g/ig, msg.guild.id));
                }
                await msg.channel.send(rich);
                return Promise.resolve(true);
            }
            for (const [presetK, presetFrom] of Object.entries(presetCfgs)) {
                if (presetK === from) {
                    // preset execute
                    for (let preFrom of presetFrom) {
                        preFrom = preFrom.replace(/%g/ig,msg.guild.id);
                        richE.push(await this.setConfig(preFrom,to,cmd.endsWith("보여")));
                    }
                    result = true;
                    break;
                }
            }
            if (!result) {
                richE.push(await this.setConfig(from,to,cmd.endsWith("보여")));
            }
            for (const rich of richE) {
                if (rich != null) {
                    await msg.channel.send(rich);
                }
            }
        }
        /**
         * Pseudo admin auth
         */
        const _adm = adminCmd.test(cmd,pieces,paramPair);
        if (!result && msg.channel.type === "dm" && _adm.match) {
            const str5 = _adm.get(ParamType.to);
            if (str5.toLowerCase() === this.global.token.substr(0,5).toLowerCase()) {
                const id = msg.author.id;
                this.global.authUsers.push(id);
                await msg.channel.send(sprintf(this.lang.adminGranted, { mention: DiscordFormat.mentionUser(id) }));
                await this.global.export().catch(err => Log.e); 
            }
            result = true;
        }
        /**
         * Save
         */
        const _save = saveCmd.test(cmd,pieces,paramPair);
        if (!result && _save.match) {
            this.emit("save");
            result = true;
        }
        return Promise.resolve(result);
    }
    private async setConfig(key:string, value:string, see = false):Promise<Discord.RichEmbed> {
        let say:object;
        for (const plugin of this.plugins) {
            const req = await plugin.setConfig(
                key, value, see);
            if (req != null) {
                say = req;
                break;
            }
        }
        if (say != null) {
            if (say.hasOwnProperty("old")) {
                const richMsg = new Discord.RichEmbed();
                richMsg.setTitle("설정: " + say["config"]);
                richMsg.addField("경로", say["key"]);
                richMsg.addField("원래 값", say["old"]);
                if (!see) {
                    richMsg.addField("새로운 값", say["value"]);
                }
                // richMsg.setDescription(say.str);
                return Promise.resolve(richMsg);
            } else {
                const richMsg = new Discord.RichEmbed();
                richMsg.setDescription(say["str"]);
                return Promise.resolve(richMsg);
            }
        }
        return Promise.resolve(null);
    }
    private filterEmpty(value:string):boolean {
        return value.length >= 1;
    }
}
export function getNickname(msg:Discord.Message) {
    if (msg.channel.type !== "dm" && msg.guild.member(msg.author) != null) {
        const guildnick = msg.guild.member(msg.author).nickname;
        return guildnick != null ? guildnick : msg.author.username;
    } else {
        return msg.author.username;
    }
}
export class MainCfg extends Config {
    public token = "_";
    public authUsers:string[] = [];
    protected prefixRegex = (/^(네코\s*메이드\s+)?(프레|레타|프레타|프렛땨|네코|시로)(야|[짱쨩]아?|님)/).source;
    constructor() {
        super("main");
        this.blacklist.push("prefix");
    }
    public get prefix():RegExp {
        return new RegExp(this.prefixRegex,"i");
    }
    public set prefix(value:RegExp) {
        this.prefixRegex = value.toString();
    }
    public isAdmin(id:string) {
        return this.authUsers.indexOf(id) >= 0;
    }
}