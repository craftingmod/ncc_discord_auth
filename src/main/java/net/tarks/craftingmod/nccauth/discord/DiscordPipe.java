package net.tarks.craftingmod.nccauth.discord;

import com.google.gson.GsonBuilder;
import net.dv8tion.jda.core.AccountType;
import net.dv8tion.jda.core.JDA;
import net.dv8tion.jda.core.JDABuilder;
import net.dv8tion.jda.core.entities.*;
import net.dv8tion.jda.core.events.guild.member.GuildMemberJoinEvent;
import net.dv8tion.jda.core.events.guild.member.GuildMemberNickChangeEvent;
import net.dv8tion.jda.core.events.message.MessageReceivedEvent;
import net.dv8tion.jda.core.exceptions.RateLimitedException;
import net.dv8tion.jda.core.hooks.EventListener;
import net.dv8tion.jda.core.hooks.ListenerAdapter;
import net.tarks.craftingmod.nccauth.Config;
import net.tarks.craftingmod.nccauth.Util;

import javax.security.auth.login.LoginException;
import java.util.ArrayList;
import java.util.List;
import java.util.StringJoiner;

public class DiscordPipe extends AuthQueue implements EventListener {
    protected JDA discordClient;

    public DiscordPipe(Config c,ICommander cmd){
        super(c,cmd);
        try {
            discordClient = new JDABuilder(AccountType.BOT).setToken(cfg.discordToken).buildBlocking();
        } catch (LoginException | InterruptedException e) {
            e.printStackTrace();
        }
        if(discordClient == null){
            System.err.println("Login fail.");
            return;
        }
        discordClient.addEventListener(this);
        discordClient.addEventListener(new InitListener());
        //discordClient.getGuildById(152746825806381056L).getTextChannelById(236873884283043842L).sendMessage("앙뇽");
    }

    /**
     * Event on auth success or fail(token = -1)
     * @param users
     */
    @Override
    protected void onAuthResult(ArrayList<DiscordUser> users) {
        for(DiscordUser user : users){
            System.out.println("Result: " + Util.getJsonPretty(new GsonBuilder().create().toJson(user)));
            TextChannel channel = discordClient.getTextChannelById(user.saidChannelID);
            String msg;
            if(user.token < 0){
                msg = "<@!#discordid>님의 인증시간(#m분)이 초과되었습니다.\n다시 해주세요.".replace("#discordid",Long.toString(user.userID))
                        .replace("#m",Integer.toString(Math.abs(user.token)));
            }else{
                msg = "<@!#discordid>님(#cafeid)의 인증이 완료되었습니다. #suffix".replace("#discordid",Long.toString(user.userID))
                        .replace("#cafeid",user.cafeID).replace("#suffix",cfg.discordAuthedMsg);
            }
            if(!channel.canTalk()){
                try {
                    discordClient.getUserById(user.userID).openPrivateChannel().complete(true).sendMessage(msg).queue();
                } catch (RateLimitedException e) {
                    e.printStackTrace();
                }
            }else{
                channel.sendMessage(msg).queue();
            }
        }
    }
    /**
     * Detect nickname change
     * @param event
     */
    @Override
    public void onGuildMemberNickChange(GuildMemberNickChangeEvent event) {
        String prevnick = event.getPrevNick();
        String newnick = event.getNewNick();
        if(prevnick == null){
            prevnick = event.getUser().getName() + " (기본)";
        }else{
            //prevnick = "**" + prevnick + "**";
        }
        if(newnick == null){
            newnick = event.getUser().getName() + " (기본)";
        }else{
            //newnick = "**" + newnick + "**";
        }
        // nickname change
        discordClient.getTextChannelById(cfg.discordBotChID).sendMessage(String.format(
                "<@!#discordid>님이 닉네임을 변경하였습니다.```\n%s -> %s\n```".replace("#discordid",Long.toString(event.getUser().getIdLong())),prevnick,newnick)).queue();
    }

    @Override
    public void onGuildMemberJoin(GuildMemberJoinEvent event) {
        String msg = cfg.discordWelcomeMsg;
        msg = msg.replace("$username",event.getUser().getName())
                .replace("$channel","<#" + cfg.discordMainChID + ">");
        event.getGuild().getTextChannelById(cfg.discordMainChID).sendMessage(msg).queue();
    }

    /**
     * Message receiver to detect command.
     * @param event
     */
    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        execCommand(event);

        if (event.isFromType(ChannelType.PRIVATE))
        {
            System.out.printf("[PM] %s: %s\n", event.getAuthor().getName(),
                    event.getMessage().getContentDisplay());
        } else {
            System.out.printf("[%s][%s] %s: %s\n", event.getGuild().getName(),
                    event.getTextChannel().getName(), event.getMember().getEffectiveName(),
                    event.getMessage().getContentDisplay());
            if(event.getMessage().getContentDisplay().startsWith("^test")){

            }
        }
    }
    public void execCommand(MessageReceivedEvent event){
        if(!event.getMessage().isFromType(ChannelType.VOICE)){
            User sender = event.getAuthor();
            String content = event.getMessage().getContentRaw();
            /*
            Auth command
             */
            if(content.startsWith("/auth")){
                if(!event.isFromType(ChannelType.PRIVATE)){
                    if(event.getGuild().getIdLong() == cfg.discordRoomID){
                        // receive auth command
                        String[] split = content.split(" ");
                        DiscordUser user = new DiscordUser(sender.getIdLong(),event.getChannel().getIdLong());
                        user.saidChannelID = event.getTextChannel().getIdLong();
                        List<Member> members = event.getGuild().getMembers();
                        String name = null;
                        for(Member mb:members){
                            if(mb.getUser().getIdLong() == user.userID){
                                name = mb.getEffectiveName();
                                break;
                            }
                        }
                        if(name == null){
                            name = event.getAuthor().getName();
                        }
                        user.username = name;
                        if(split.length >= 2){
                            if(split.length == 2 && split[1].matches("^[a-zA-Z0-9]*$")){
                                user.cafeID = split[1];
                                user.username = split[1];
                            }else{
                                if(user.username.length() >= 1){
                                    user.username = content.substring(content.indexOf(" ")+1);
                                }
                            }
                        }
                        try {
                            PrivateChannel pChannel = sender.openPrivateChannel().complete(true);
                            int auth = this.requestAuth(user);
                            if(auth >= 0){
                                pChannel.sendMessage("<@!#discordid>님이 회원임을 인증할려면 **#minute분안에** #url 에 __#num__ 숫자를 댓글에 남겨주세요.\n"
                                        .replace("#discordid",Long.toString(sender.getIdLong()))
                                        .replace("#url",cfg.cafeCommentURL)
                                        .replace("#num",Integer.toString(auth)).replace("#minute",Long.toString(limit_minute))).queue();
                            }
                            event.getTextChannel().sendMessage((auth >= 0)?String.format("인증 코드를 개인메세지로 보냈습니다. %s 닉네임만 인증됩니다.",name):String.format("이미 인증 대기중 입니다. %s초 남았습니다.",Math.abs(auth))).queue();
                        } catch (RateLimitedException e) {
                            e.printStackTrace();
                            event.getTextChannel().sendMessage("실패: 개인 메세지를 사용할 수 없습니다.").queue();
                        }
                    }
                }
            }
            if(content.startsWith("!emuWelcome")){
                String msg = cfg.discordWelcomeMsg;
                msg = msg.replace("$username","<@!" + event.getAuthor().getIdLong() + ">")
                        .replace("$channel","<#" + cfg.discordMainChID + ">");
                event.getGuild().getTextChannelById(cfg.discordMainChID).sendMessage(msg).queue();
            }
                        /*
            Set config command
             */
            if(content.startsWith("/setconfig") && content.split(" ")[0].equalsIgnoreCase("/setconfig")){
                System.out.println("Hello");
                PrivateChannel pChannel;
                try {
                    pChannel = sender.openPrivateChannel().complete(true);
                }catch (RateLimitedException e){
                    e.printStackTrace();
                    return;
                }
                if(event.isFromType(ChannelType.PRIVATE)){
                    String[] splits = content.split(" ");
                    String[] inputS = {"discordToRolesName","discordWelcomeMsg","discordAuthedMsg"};
                    String[] inputL = {"discordRoomID","discordBotChID","discordMainChID"};
                    if(splits.length >= 3){
                        if(cfg.trustedUsers.contains(sender.getIdLong())){
                            // set field sudo
                            boolean modded = false;
                            for(String is : inputS){
                                if(splits[1].equals(is) && splits[2].length() >= 1){
                                    try {
                                        String pt = content.substring(content.indexOf(" ")+1);
                                        cfg.getClass().getField(is).set(cfg,pt.substring(pt.indexOf(" ")+1));
                                        modded = true;
                                        break;
                                    } catch (IllegalAccessException | NoSuchFieldException e) {
                                        e.printStackTrace();
                                    }
                                }
                            }
                            if(!modded){
                                for(String il : inputL){
                                    if(splits[1].equals(il) && splits[2].length() >= 1){
                                        try {
                                            cfg.getClass().getField(il).setLong(cfg,Long.parseLong(splits[2]));
                                            modded = true;
                                            break;
                                        } catch (IllegalAccessException | NoSuchFieldException | NumberFormatException e) {
                                            e.printStackTrace();
                                        }
                                    }
                                }
                            }
                            if(modded){
                               cmd.saveConfig(cfg);
                            }
                        }else{
                            pChannel.sendMessage("권한을 얻기 위하여 token의 첫 5자리를 ```\n/setconfig <token>\n```\n으로 입력해주세요.").queue();
                        }
                    }else if(splits.length == 2 && splits[1].equals(cfg.discordToken.substring(0,5))){
                        if(!cfg.trustedUsers.contains(sender.getIdLong())){
                            cfg.trustedUsers.add(sender.getIdLong());
                            cmd.saveConfig(cfg);
                        }
                        pChannel.sendMessage("인증 완료").queue();
                    }else if(splits.length == 1 && cfg.trustedUsers.contains(sender.getIdLong())){
                        pChannel.sendMessage(String.format("String: %s\nLong: %s",String.join(",",inputS),String.join(",",inputL))).queue();
                    }
                }
            }
        }
    }
}
