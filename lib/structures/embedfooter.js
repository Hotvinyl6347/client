const BaseStructure = require('./basestructure');

const defaults = {
	text: null,
	icon_url: null,
	proxy_icon_url: null
};

class EmbedFooter extends BaseStructure {
	constructor(embed, data) {
		super(embed.client, data, defaults);
		Object.defineProperty(this, 'embed', {value: embed});
	}

	fetchIcon(query) {return this.client.rest.request({method: 'get', url: this.iconUrl, query});}
	fetchIconProxy(query) {return this.client.rest.request({method: 'get', url: this.proxyIconUrl, query});}
}

module.exports = EmbedFooter;