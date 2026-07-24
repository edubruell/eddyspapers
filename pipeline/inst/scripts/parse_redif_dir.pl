#!/usr/bin/env perl

use strict;
use warnings;

BEGIN {
    my $home = $ENV{HOME};
    unshift @INC,
        "$home/perl5/lib/perl5",
        "$home/perl5/lib/perl5/darwin-thread-multi-2level";
}

use ReDIF::Parser qw(
    redif_open_dir_recursive
    redif_get_next_template_good_or_bad
);

use JSON;

my $dir = shift @ARGV or die "Usage: $0 directory [template-type]\n";
my $want_type = shift @ARGV || 'ReDIF-Person 1.0';

redif_open_dir_recursive($dir);

my $json = JSON->new->utf8->pretty;
print "[\n";
my $count = 0;

while (my $template = redif_get_next_template_good_or_bad()) {
    next unless defined $template->{TYPE} && $template->{TYPE} eq $want_type;
    print ",\n" if $count++;
    print $json->encode($template);
}

print "\n]\n";
