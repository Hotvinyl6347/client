'use strict';

const fs = require('fs');
const path = require('path');

const Client = require('./client');
const ClusterClient = require('./clusterclient');

const Context = require('./command/context');
const Utils = require('./utils');

const defaults = {
	activateOnEdits: false,
	maxEditDuration: 0,
	mentionsEnabled: true,
	useClusterClient: true
};

class CommandClient extends Utils.EventEmitter
{
	constructor(token, options)
	{
		super();

		options = Object.assign({}, defaults, options);

		let client;
		if (typeof(token) === 'string') {
			client = new ((options.useClusterClient) ? ClusterClient : Client)(token, options);
		} else {
			client = token;
		}

		if (!client || !(client instanceof Client || client instanceof ClusterClient)) {
			throw new Error('Token has to be a string or an instance of a client!');
		}

		Object.defineProperties(this, {
			client: {enumerable: true, value: client},
			commands: {enumerable: true, value: []},
			prefixes: {enumerable: true, value: {custom: new Set(), mention: new Set()}},
			ran: {enumerable: true, configurable: true, value: client.ran}
		});

		if (options.prefix) {
			if (!options.prefixes) {
				options.prefixes = [];
			}
			options.prefixes.push(options.prefix);
		}

		if (options.prefixes) {
			options.prefixes.sort((x, y) => x.length < y.length).forEach((x) => this.prefixes.custom.add(x));
		}

		Object.defineProperties(this, {
			activateOnEdits: {enumerable: true, configurable: true, value: options.activateOnEdits},
			maxEditDuration: {enumerable: true, configurable: true, value: options.maxEditDuration},
			mentionsEnabled: {enumerable: true, configurable: true, value: !!options.mentionsEnabled},
			prefixSpace: {enumerable: true, configurable: true, value: !!options.prefixSpace}
		});

		if (this.ran) {
			this.addMentionPrefixes();
		}

		if (!this.prefixes.custom.size && !this.mentionsEnabled) {
			throw new Error('You must pass in prefixes or enable mentions!');
		}

		this.client.on('MESSAGE_CREATE', this.handle.bind(this, 'MESSAGE_CREATE'));
		this.client.on('MESSAGE_UPDATE', this.handle.bind(this, 'MESSAGE_UPDATE'));
	}

	setActivateOnEdits(enabled) {Object.defineProperty(this, 'activateOnEdits', {value: !!enabled});}
	setMaxEditDuration(duration) {Object.defineProperty(this, 'maxEditDuration', {value: duration});}
	setMentionsEnabled(enabled) {Object.defineProperty(this, 'mentionsEnabled', {value: !!enabled});}

	addMentionPrefixes()
	{
		let user;
		if (this.client instanceof ClusterClient) {
			user = this.client.shards.get(this.client.shardStart).user;
		} else {
			user = this.client.user;
		}

		this.prefixes.mention.add(user.mention);
		this.prefixes.mention.add(`<@!${user.id}>`);
	}

	clearCommands()
	{
		for (let command of this.commands) {
			if (!command.file) {continue;}
			const mod = require.resolve(command.file);
			if (!mod) {continue;}
			delete require.cache[mod];
		}
		this.commands.length = 0;
	}

	registerCommand(cmd)
	{
		if (typeof(cmd) === 'function') {cmd = {class: cmd};}

		const command = new cmd.class(this);
		Object.defineProperty(command, 'file', {value: cmd.file || null});

		if (this.commands.some((c) => c.check(command.name))) {
			throw new Error(`Alias/name ${command.name} already exists.`);
		}

		for (let alias of command.aliases) {
			if (this.commands.some((c) => c.check(alias))) {
				throw new Error(`Alias/name ${alias} already exists.`);
			}
		}

		this.commands.push(command);
	}

	registerCommands(commands)
	{
		for (let cmd of commands) {
			this.registerCommand(cmd);
		}
	}

	registerCommandsIn(directory)
	{
		return new Promise((resolve, reject) => {
			fs.readdir(directory, (error, files) => (error) ? reject(error) : resolve(files));
		}).then((files) => {
			for (let file of files) {
				const filepath = path.resolve(directory, file);
				const command = require(filepath);
				if (typeof(command) === 'function') {
					this.registerCommand({class: command, file: filepath});
				}
			}
		});
	}

	getAttributes(args)
	{
		if (!args.length) {return;}

		const attributes = {args};

		if (this.prefixSpace) {
			attributes.prefix = args.shift().toLowerCase();
			if (!this.prefixes.custom.has(attributes.prefix) && (this.mentionsEnabled && !this.prefixes.mention.has(attributes.prefix))) {return;}
		} else {
			const first = attributes.args[0].toLowerCase();
			for (let prefix of this.prefixes.custom.values()) {
				if (first.startsWith(prefix)) {
					attributes.prefix = first.substring(0, prefix.length);
					break;
				}
			}
			if (attributes.prefix) {
				attributes.args[0] = attributes.args[0].substring(attributes.prefix.length);
			} else {
				for (let prefix of this.prefixes.mention.values()) {
					if (first === prefix) {
						attributes.prefix = attributes.args.shift();
						break;
					}
				}
			}
		}

		return (attributes.prefix) ? attributes : null;
	}

	getCommand(args)
	{
		const command = (args.shift() || '').toLowerCase();
		return (command) ? this.commands.find((cmd) => cmd.check(command)) : null;
	}

	handle(name, event)
	{
		if (name === 'MESSAGE_UPDATE' && (!this.activateOnEdits || event.differences.content === undefined)) {return;}

		const message = event.message;
		const context = new Context(message, event.client || this.client);

		const payload = {context};
		return new Promise((resolve, reject) => {
			if (!message.fromUser) {return reject(new Error('Message is not from a User.'));}
			if (message.isEdited) {
				const difference = message.editedTimestampUnix - message.createdAtUnix;
				if (difference > this.maxEditDuration) {
					return reject(new Error('Edit timestamp higher than max edit duration'));
				}
			}

			const attributes = this.getAttributes(message.content.split(' '));
			if (!attributes) {return reject(new Error('Does not start with any allowed prefixes'));}

			const command = this.getCommand(attributes.args);
			if (!command) {return reject(new Error('No command found'));}

			if (!command.responseOptional && !message.canReply) {
				const error = new Error('Cannot send messages in this channel.');
				error.code = Utils.Constants.Detritus.Command.Errors.GENERAL;
				error.command = command;
				return reject(error);
			}

			if (command.ratelimit) {
				let ratelimitId;
				switch (command.ratelimit.settings.type) {
					case 'guild': ratelimitId = (message.inDm) ? message.channelId : message.guildId; break;
					case 'channel': ratelimitId = message.channelId; break;
					default: ratelimitId = message.author.id;
				}
				const ratelimit = command.getRatelimit(ratelimitId);
				if (ratelimit.usages + 1 > command.ratelimit.settings.limit) {
					const error = new Error('Ratelimited');
					error.code = Utils.Constants.Detritus.Command.Errors.RATELIMIT;
					error.command = command;
					error.ratelimit = ratelimit;
				} else {
					ratelimit.usages++;
				}
			}

			if (command.disableDm && message.inDm) {
				const error = new Error('Cmomand with DMs disabled used in DM.');
				error.code = Utils.Constants.Detritus.Command.Errors.GENERAL;
				error.command = command;
				if (command.disableDmReply) {
					return message.reply(`Cannot use \`${command.name}\` in DMs.`).then((msg) => {
						error.response = msg;
					}, (e) => {
						error.responseError = e;
					}).then(() => reject(error));
				} else {
					return reject(error);
				}
			}

			resolve({command, attributes});
		}).then(({command, attributes}) => {
			const args = command.getArgs(attributes.args);

			payload.prefix = attributes.prefix;
			payload.args = Object.assign({}, args);

			return new Promise((resolve, reject) => {
				Promise.resolve(command.run(context, args)).then(resolve).catch(reject);
			}).then(() => {
				this.emit('COMMAND_RAN', payload);
			}, (error) => {
				error.code = Utils.Constants.Detritus.Command.Errors.RAN;
				return Promise.reject(error);
			});
		}).catch((error) => {
			payload.error = error;
			if (error.code === undefined) {
				return this.emit('COMMAND_NONE', payload);
			}

			switch (error.code) {
				case Utils.Constants.Detritus.Command.Errors.RATELIMIT: {
					payload.remaining = ((error.ratelimit.start + error.command.ratelimit.settings.duration) - Date.now());
				}; break;
			}
			return this.emit('COMMAND_FAIL', payload);
		});
	}

	run(options)
	{
		if (this.ran) {return Promise.resolve(this);}

		options = Object.assign({}, options, {wait: true});
		return this.client.run(options).then(() => {
			Object.defineProperty(this, 'ran', {value: true});
			this.addMentionPrefixes();
			return this.client;
		});
	}
}

CommandClient.Command = require('./command');
module.exports = CommandClient;